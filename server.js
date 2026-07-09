import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'url';
import db from './database.js';
import scheduler from './scheduler.js';
import { getConfig, isNightTime, getDailyQuota, getIsraelTime, computeDynamicContactCap, getContactStatus, isDailyQuotaReached } from './config.js';
import { sendMessage, markRead, sendReaction, sendTypingState, handleLimitStop } from './evolution.js';
import { generateReply, generateGroupReply } from './gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Only enable if this server actually sits behind a reverse proxy/load
// balancer that sets X-Forwarded-For — otherwise clients could spoof their
// IP and dodge the vote rate limiter below.
// app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Text extractor helper from various Evolution API payload message structures
 */
function extractTextFromMessage(messageObj) {
  if (!messageObj) return null;
  if (typeof messageObj === 'string') return messageObj;
  if (messageObj.conversation) return messageObj.conversation;
  if (messageObj.extendedTextMessage?.text) return messageObj.extendedTextMessage.text;
  if (messageObj.imageMessage?.caption) return messageObj.imageMessage.caption;
  if (messageObj.videoMessage?.caption) return messageObj.videoMessage.caption;
  return null;
}

/**
 * Webhook endpoint to receive events from Evolution API.
 * If a webhookSecret is configured, requests must present it via the URL path
 * segment, an 'x-webhook-secret' header, or a 'secret' query param - otherwise
 * anyone who finds this URL could inject fake incoming messages.
 */
app.post(['/webhook/:secret', '/api/webhook/:secret', '/webhook', '/api/webhook'], async (req, res) => {
  const config = getConfig();
  if (config.webhookSecret) {
    const providedSecret = req.params.secret || req.headers['x-webhook-secret'] || req.query.secret;
    if (providedSecret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing webhook secret' });
    }
  } else {
    console.warn('WARNING: No webhookSecret configured - /webhook is publicly reachable without authentication. Set one in Settings.');
  }

  const { event, data } = req.body;

  // Return early if payload doesn't contain needed keys
  if (!event || !data) {
    return res.status(400).json({ status: 'ignored', reason: 'Missing event or data' });
  }

  // 1. We only process incoming messages (messages.upsert)
  if (event !== 'messages.upsert') {
    return res.json({ status: 'ignored', reason: `Event ${event} is not processed` });
  }

  // 2. Ignore messages sent by the bot itself to prevent infinite loops
  const fromMe = data.key?.fromMe;
  if (fromMe === true) {
    return res.json({ status: 'ignored', reason: 'Message sent by self' });
  }

  const remoteJid = data.key?.remoteJid;
  if (!remoteJid) {
    return res.json({ status: 'ignored', reason: 'Missing remoteJid' });
  }

  const messageText = extractTextFromMessage(data.message);
  if (!messageText) {
    return res.json({ status: 'ignored', reason: 'Empty or non-text message' });
  }

  const isGroup = remoteJid.endsWith('@g.us');
  const senderName = data.pushName || data.senderName || 'Anonymous';

  try {
    // ----------------------------------------------------
    // CASE A: GROUP MESSAGE
    // ----------------------------------------------------
    if (isGroup) {
      const config = getConfig();
      
      // Always mark group messages as read (simulates active device consumption)
      await markRead(remoteJid);

      // Check if group responses are active (Only in Week 2, currentDay >= 8)
      if (config.warmupEnabled && config.groupsEnabled && config.currentDay >= 8) {
        const today = db.getTodayDateString();
        const todayStats = db.getStatsForDate(today);

        // Check if we haven't hit the daily group reply quota
        if (todayStats.group < config.groupReplyLimitPerDay) {
          // Ask Gemini if this warrants a response
          const decision = await generateGroupReply(senderName, messageText);
          
          if (decision && decision.toUpperCase() !== 'SKIP') {
            console.log(`Responding to group (${remoteJid}) message: "${decision}"`);
            await db.addLog('info', `Group reaction determined for message from ${senderName}`, messageText, remoteJid);
            
            // Wait a random delay (4 to 10 seconds) to simulate reading and writing in group
            const groupTypeDelay = Math.floor(Math.random() * 6000) + 4000;
            setTimeout(async () => {
              await sendMessage(remoteJid, decision, false);
              await db.incrementStat('group'); // Increment group reply count
              await db.addLog('success', `Reacted in group ${remoteJid}: "${decision}"`);
            }, groupTypeDelay);
          }
        }
      }
      return res.json({ status: 'success', type: 'group' });
    }

    // ----------------------------------------------------
    // CASE B: PRIVATE MESSAGE
    // ----------------------------------------------------
    const phone = remoteJid.split('@')[0];
    const contacts = db.getContacts();
    const contact = contacts.find(c => c.phone === phone);

    // If sender is NOT a guided contact, ignore their messages to avoid out-of-context replies.
    if (!contact || !contact.enabled) {
      console.log(`Ignoring message from non-guided/disabled number ${phone}: "${messageText}"`);
      await db.addLog('info', `Ignored message from unguided number: ${phone}`, messageText, phone);
      return res.json({ status: 'ignored', reason: 'Not an active guided contact' });
    }

    // Log the incoming message and update statistics immediately
    await db.incrementStat('incoming');
    await db.addLog('message', `Received: ${messageText}`, messageText, phone, false);

    // Update contact status
    await db.updateContact(phone, {
      lastInteractionAt: new Date().toISOString(),
      messageCount: contact.messageCount + 1
    });

    // Self-serve opt-out ("תפסיק לכתוב לי" -> confirm "כן תפסיק"). Checked
    // before warmupEnabled/quota/night/delay so a real person asking to
    // stop always gets an immediate response no matter what state the bot
    // is otherwise in. Opportunistically drops stale (>15min unconfirmed)
    // pending requests from any phone on every incoming message, so no
    // separate sweep job is needed.
    const OPT_OUT_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
    const optOutSettings = db.getSettings();
    const activePendingOptOuts = (optOutSettings.pendingOptOuts || [])
      .filter(p => Date.now() - new Date(p.requestedAt).getTime() < OPT_OUT_CONFIRM_WINDOW_MS);
    const pendingOptOut = activePendingOptOuts.find(p => p.phone === phone);

    if (pendingOptOut) {
      const isConfirmed = messageText.trim().replace(/[.!?,]/g, '') === 'כן תפסיק';
      await db.saveSettings({ pendingOptOuts: activePendingOptOuts.filter(p => p.phone !== phone) });
      if (isConfirmed) {
        await db.optOutContact(phone);
        await sendMessage(phone, 'סבבה, מבין. ביי 👋 אם תתגעגע אתה יודע איפה למצוא אותי');
        await db.addLog('success', `Contact ${contact.name || phone} opted out via chat command.`);
        return res.json({ status: 'success', detail: 'Contact opted out' });
      }
      // Not a confirmation - pending already cleared above, fall through to normal reply handling.
    } else if (messageText.includes('תפסיק לכתוב לי')) {
      await db.saveSettings({ pendingOptOuts: [...activePendingOptOuts, { phone, requestedAt: new Date().toISOString() }] });
      await sendMessage(phone, "רגע רגע יא חבר, אתה רציני? 😢 תכתוב לי 'כן תפסיק' ואני נעלם מהחיים שלך לתמיד");
      return res.json({ status: 'success', detail: 'Opt-out confirmation requested' });
    }

    const config = getConfig();
    if (!config.warmupEnabled) {
      console.log(`Warmup is disabled. Read receipt will be sent to ${phone} after delay, but reply skipped.`);
      setTimeout(async () => {
        try {
          await sendTypingState(phone, 'available', 1500);
          await markRead(remoteJid, data.key);
        } catch (e) {
          console.error('Failed to mark read in disabled mode:', e);
        }
      }, 3000);
      return res.json({ status: 'success', detail: 'Read only, warmup disabled' });
    }

    // Check emergency hard ceiling for incoming replies (1.5x daily quota)
    // Regular dailyQuota stops active warmup initiations in scheduler, but we allow replying to existing conversations up to 1.5x quota!
    const todayStr = db.getTodayDateString();
    const stats = db.getStatsForDate(todayStr);
    const dailyQuota = getDailyQuota();
    const emergencyQuota = Math.floor(dailyQuota * 1.5);
    if (stats.outgoing >= emergencyQuota) {
      await handleLimitStop(phone, remoteJid, data.key, contact.name, `Emergency quota reached (${stats.outgoing}/${emergencyQuota})`);
      return res.json({ status: 'success', detail: 'Emergency quota reached' });
    }

    // Check per-contact daily conversation depth cap with human variance (-1, 0, +1 around base limit)
    const contactCap = computeDynamicContactCap(phone, config);
    if (contactCap.reached) {
      await handleLimitStop(phone, remoteJid, data.key, contact.name, `Conversation depth reached (${contactCap.count}/${contactCap.cap})`);
      return res.json({ status: 'success', detail: 'Max daily contact depth reached' });
    }

    // Check night rest mode (only if enabled in dashboard settings)
    if (config.nightRestEnabled && isNightTime()) {
      await scheduler.queueNightMessage(phone, messageText, contact.name, data.key, remoteJid);
      return res.json({ status: 'success', detail: 'Queued for morning' });
    }

    // Check if we should simulate being "busy" (ghosting) for this reply
    const settings = db.getSettings();
    const delayedReplies = settings.delayedReplies || [];
    const existingReplyIdx = delayedReplies.findIndex(r => r.phone === phone);
    const isAlreadyDelayed = existingReplyIdx !== -1;

    const shouldDelay = config.busySimulationEnabled && (isAlreadyDelayed || Math.random() < config.busySimulationChance);
    if (shouldDelay) {
      if (isAlreadyDelayed) {
        // Update the queued reply with the latest message text and key
        delayedReplies[existingReplyIdx].messageText = messageText;
        delayedReplies[existingReplyIdx].msgKey = data.key;
        await db.saveSettings({ delayedReplies });
        await db.addLog('info', `Contact ${contact.name || phone} is already in busy/away delay. Appending new message to queue.`, messageText, phone);
      } else {
        const delayMinutes = Math.floor(Math.random() * (config.maxBusyDelayMinutes - config.minBusyDelayMinutes + 1)) + config.minBusyDelayMinutes;
        const sendAfter = new Date(Date.now() + delayMinutes * 60000).toISOString();
        
        await scheduler.queueDelayedReply(phone, remoteJid, messageText, contact.name, data.key, sendAfter);
        await db.addLog('info', `Simulating busy/away status: Delaying reply to ${contact.name || phone} by ${delayMinutes} minutes (Will reply around ${new Date(sendAfter).toLocaleTimeString('he-IL')}).`, messageText, phone);
      }
      return res.json({ status: 'success', detail: `Delayed reply` });
    }

    // Process the humanized reply sequence asynchronously in the background
    // to return the HTTP response immediately to the Evolution API webhook dispatcher
    setTimeout(async () => {
      try {
        await db.addLog('info', `Starting humanized reply sequence for ${phone}`);

        // 1. Wait a random human delay (3 to 7 seconds) before opening the app
        const readDelay = Math.floor(Math.random() * 4000) + 3000;
        console.log(`Delaying app open simulation for ${phone} by ${readDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, readDelay));

        // 2. Go "Online" (available) to simulate opening the app
        await db.addLog('info', `Simulating user online (available) for ${phone}`);
        await sendTypingState(phone, 'available', 1500);

        // 3. Mark message as read (V כחול)
        await db.addLog('info', `Marking message as read (blue checks) for ${phone}`);
        await markRead(remoteJid, data.key);

        // 4. Wait a short delay before starting to type (simulate reading: 1.5 seconds)
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 5. Generate natural response using Gemini
        await db.addLog('info', `Calling Gemini to generate reply for ${phone}`);
        const logs = db.getLogs().filter(log => log.phone === phone);
        const history = logs.slice(0, 10).reverse();
        const replyText = await generateReply(contact.name, messageText, history, config.currentDay, contact.notes);
        await db.addLog('info', `Gemini response generated for ${phone}: "${replyText}"`);

        // 6. Send reaction or message reply
        const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
        if (reactionMatch) {
          const emoji = reactionMatch[1].trim();
          if (data.key?.id) {
            await db.addLog('info', `Sending emoji reaction "${emoji}" to ${phone}`);
            const success = await sendReaction(remoteJid, emoji, data.key);
            if (!success) {
              // Fallback to normal text message containing the emoji
              console.log(`sendReaction failed. Falling back to sending emoji "${emoji}" as text.`);
              await sendMessage(phone, emoji, true);
            }
          }
        } else {
          // sendMessage will simulate typing based on text length (2s - 6s)
          await db.addLog('info', `Sending text reply to ${phone}`);
          await sendMessage(phone, replyText, true);
        }

        // 7. Go "Offline" (unavailable) to simulate closing the app
        await db.addLog('info', `Simulating user offline (unavailable) for ${phone}`);
        await sendTypingState(phone, 'unavailable', 500);
      } catch (err) {
        console.error('Error in asynchronous reply pipeline:', err);
        await db.addLog('error', `Async reply pipeline failed: ${err.message}`);
      }
    }, 100);

    return res.json({ status: 'success', type: 'queued_reply' });
  } catch (error) {
    console.error('Error handling webhook message:', error);
    await db.addLog('error', `Webhook handler failed: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// DASHBOARD API ENDPOINTS
// ----------------------------------------------------

/**
 * Strips secrets (API keys, tokens, admin PIN) from a config object before
 * it's sent to unauthenticated clients.
 */
function sanitizeConfigForPublic(config) {
  const { geminiApiKey, evolutionToken, adminPin, webhookSecret, ...publicConfig } = config;
  return {
    ...publicConfig,
    hasGeminiKey: !!geminiApiKey,
    hasEvolutionToken: !!evolutionToken
  };
}

/**
 * Get current configuration, status, stats for today, and queued item counts
 */
app.get('/api/status', (req, res) => {
  const config = sanitizeConfigForPublic(getConfig());
  const today = db.getTodayDateString();
  const stats = db.getStatsForDate(today);
  const dailyQuota = getDailyQuota();
  const settings = db.getSettings();

  res.json({
    config,
    stats: {
      todayDate: today,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      group: stats.group,
      total: stats.total,
      quota: dailyQuota
    },
    nightQueueLength: (settings.nightQueue || []).length,
    delayedReplies: settings.delayedReplies || [],
    nightQueue: settings.nightQueue || [],
    dailyQuotaReached: isDailyQuotaReached(),
    isNight: isNightTime()
  });
});

/**
 * Middleware to verify Admin PIN for state mutating actions
 */
function requireAdmin(req, res, next) {
  const config = getConfig();
  const requiredPin = config.adminPin || process.env.ADMIN_PIN || 'Liran!192837';
  const providedPin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin;
  
  if (!providedPin || providedPin !== requiredPin) {
    return res.status(403).json({ error: 'Unauthorized: Admin PIN required to perform this action.' });
  }
  next();
}

/**
 * Verify if provided PIN matches adminPin
 */
app.post('/api/verify-pin', (req, res) => {
  const config = getConfig();
  const requiredPin = config.adminPin || process.env.ADMIN_PIN || 'Liran!192837';
  const providedPin = req.headers['x-admin-pin'] || req.body?.pin;
  res.json({ success: providedPin === requiredPin });
});

/**
 * Admin-only: fetch the raw secret values (Gemini/Evolution credentials) so the
 * settings form can be populated. Never exposed via the public /api/status route.
 */
app.get('/api/settings/secrets', requireAdmin, (req, res) => {
  const config = getConfig();
  res.json({
    geminiApiKey: config.geminiApiKey,
    evolutionToken: config.evolutionToken,
    webhookSecret: config.webhookSecret
  });
});

/**
 * Save configuration settings
 */
app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const oldSettings = db.getSettings();
    const updated = await db.saveSettings(req.body);
    
    // If warmup was toggled ON, run active warmup cycle within 5 seconds for responsive testing
    if (req.body.warmupEnabled === true && oldSettings.warmupEnabled !== true) {
      console.log('Warmup toggled ON. Rescheduling next run to execute in 5 seconds...');
      await scheduler.scheduleNextWarmup(5000);
    } else if (req.body.activeMinIntervalMinutes !== undefined || req.body.activeMaxIntervalMinutes !== undefined) {
      // If interval configs changed, reschedule the next warmup to apply new intervals
      await scheduler.scheduleNextWarmup();
    }

    // If busy simulation was toggled OFF, immediately process all queued delayed replies
    if (req.body.busySimulationEnabled === false && oldSettings.busySimulationEnabled !== false) {
      console.log('Busy simulation toggled OFF. Immediately processing all delayed replies...');
      scheduler.processDelayedReplies();
    }

    await db.addLog('success', 'System configurations updated via dashboard.');
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reset all logs, stats, contact counters, and queues
 */
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    // 1. Clear logs
    db.logs = [];
    await db._saveFile('logs.json', db.logs);

    // 2. Clear stats
    db.stats = {};
    await db._saveFile('stats.json', db.stats);

    // 3. Reset contact counters
    db.contacts = db.contacts.map(c => ({
      ...c,
      messageCount: 0,
      lastInteractionAt: null
    }));
    await db._saveFile('contacts.json', db.contacts);

    // 4. Clear settings queues
    db.settings.nightQueue = [];
    db.settings.delayedReplies = [];
    await db.saveSettings(db.settings);

    await db.addLog('success', 'המערכת אותחלה בהצלחה! כל הנתונים, הסטטיסטיקות והתורים אופסו.');

    res.json({ success: true, message: 'All data successfully reset' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send a manual WhatsApp message to a guided contact and override any queued bot replies
 */
app.post('/api/chat/send', requireAdmin, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }

    const contact = db.getContacts().find(c => c.phone === phone);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found in guided contacts' });
    }

    // 1. Send the actual message via Evolution API (this also logs to DB and updates contact stats)
    await sendMessage(phone, message, true);

    // 2. Override/Clear any queued replies for this contact
    const settings = db.getSettings();
    let queueChanged = false;

    // Clear delayedReplies
    let delayedReplies = settings.delayedReplies || [];
    const delayedIdx = delayedReplies.findIndex(r => r.phone === phone);
    if (delayedIdx !== -1) {
      delayedReplies.splice(delayedIdx, 1);
      queueChanged = true;
    }

    // Clear nightQueue
    let nightQueue = settings.nightQueue || [];
    const nightIdx = nightQueue.findIndex(q => q.phone === phone);
    if (nightIdx !== -1) {
      nightQueue.splice(nightIdx, 1);
      queueChanged = true;
    }

    if (queueChanged) {
      await db.saveSettings({ delayedReplies, nightQueue });
      await db.addLog('info', `Human override: Cleared queued automated replies for ${contact.name || phone} due to manual message.`, '', phone);
    }

    res.json({ success: true, message: 'Message sent and queues cleared' });
  } catch (err) {
    console.error('Failed to send manual message:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger a manual WhatsApp status post (image or text)
 */
app.post('/api/status/trigger', requireAdmin, async (req, res) => {
  try {
    const result = await scheduler.triggerManualStatusPost();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Perform active connection diagnostics for Gemini and Evolution APIs
 */
app.get('/api/test-connection', async (req, res) => {
  const config = getConfig();
  const report = {
    gemini: { success: false, error: null },
    evolution: { success: false, state: 'unknown', error: null }
  };

  // 1. Test Gemini API
  try {
    const { callGemini } = await import('./gemini.js');
    const resText = await callGemini('You are a test agent. Output only the word OK.', 'Test connection check', 0.1);
    if (resText.includes('OK') || resText.trim().length > 0) {
      report.gemini.success = true;
    } else {
      report.gemini.error = 'Gemini returned an unexpected empty response.';
    }
  } catch (err) {
    report.gemini.error = err.message;
  }

  // 2. Test Evolution API
  if (!config.evolutionUrl || !config.evolutionToken || !config.evolutionInstance) {
    report.evolution.error = 'Evolution credentials are not configured in settings.';
  } else {
    try {
      const cleanUrl = config.evolutionUrl.replace(/\/$/, '');
      const url = `${cleanUrl}/instance/connectionState/${config.evolutionInstance}`;
      console.log(`Checking Evolution connection state: ${url}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'apikey': config.evolutionToken
        }
      });
      
      if (!response.ok) {
        report.evolution.error = `Evolution API error (${response.status}): ${await response.text()}`;
      } else {
        const data = await response.json();
        report.evolution.state = data.instance?.state || 'unknown';
        if (report.evolution.state === 'open') {
          report.evolution.success = true;
        } else {
          report.evolution.error = `Evolution instance is online, but WhatsApp is disconnected (state: ${report.evolution.state}). Please scan QR code!`;
        }
      }
    } catch (err) {
      report.evolution.error = err.message;
    }
  }

  res.json({
    success: report.gemini.success && report.evolution.success,
    report
  });
});

/**
 * Get all guided contacts (contains phone numbers/PII - admin only)
 */
app.get('/api/contacts', requireAdmin, (req, res) => {
  res.json(db.getContacts());
});

/**
 * Add a new guided contact
 */
app.post('/api/contacts', requireAdmin, async (req, res) => {
  try {
    const { phone, name, notes, enabled } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    // Clean number: keep digits only
    const cleanPhone = phone.replace(/\D/g, '');
    const newContact = await db.addContact({ phone: cleanPhone, name, notes, enabled });
    
    await db.addLog('success', `Added contact: ${name} (${cleanPhone})`);
    res.json({ success: true, contact: newContact });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Update contact configuration (toggle enable/notes)
 */
app.put('/api/contacts/:phone', requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateContact(req.params.phone, req.body);
    res.json({ success: true, contact: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Delete a contact
 */
app.delete('/api/contacts/:phone', requireAdmin, async (req, res) => {
  try {
    const removed = await db.deleteContact(req.params.phone);
    await db.addLog('warning', `Deleted contact: ${removed.name} (${req.params.phone})`);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get system logs (contains full conversation content - admin only)
 */
app.get('/api/logs', requireAdmin, (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : 200;
  res.json(db.getLogs(limit));
});

/**
 * Clear system logs
 */
app.post('/api/logs/clear', requireAdmin, async (req, res) => {
  try {
    db.logs = [];
    await db._saveFile('logs.json', db.logs);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger manual active starter
 */
app.post('/api/test/starter', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    const message = await scheduler.triggerManualStarter(phone);
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Simulator Endpoint: Mock an incoming message from a contact/group.
 */
app.post('/api/test/incoming', requireAdmin, async (req, res) => {
  try {
    const { phone, message, isGroup, senderName } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }

    // Construct mock Evolution API webhook payload
    const mockPayload = {
      event: 'messages.upsert',
      data: {
        key: {
          remoteJid: isGroup ? `${phone}@g.us` : `${phone}@s.whatsapp.net`,
          fromMe: false,
          id: `MOCK_MSG_${Math.random().toString(36).substring(2, 9)}`
        },
        message: {
          conversation: message
        },
        pushName: senderName || 'Mock User'
      }
    };

    // Forward to internal webhook flow asynchronously
    // Using fetch locally to simulate external POST request
    const config = getConfig();
    const serverPort = config.port;

    const response = await fetch(`http://localhost:${serverPort}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.webhookSecret ? { 'x-webhook-secret': config.webhookSecret } : {})
      },
      body: JSON.stringify(mockPayload)
    });

    const result = await response.json();
    res.json({ success: true, webhookResult: result });
  } catch (err) {
    console.error('Simulator trigger failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// PUBLIC LEADERBOARD (viewer mode) + ADMIN CURATION
// ----------------------------------------------------

/**
 * Issues a long-lived, httpOnly voter identity cookie on first visit to the
 * public leaderboard. Used to dedupe votes (one vote per chat per voter) -
 * not a strong identity guarantee on its own, paired with the IP-based rate
 * limiter below against casual abuse.
 */
function voterIdentity(req, res, next) {
  let voterId = req.cookies?.voterId;
  if (!voterId) {
    voterId = crypto.randomUUID();
    res.cookie('voterId', voterId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
  }
  req.voterId = voterId;
  next();
}

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many votes, slow down and try again in a minute.' }
});

/**
 * Public: list published leaderboard chats. Only ever returns fields
 * filtered through db.toPublicChat() - never contactPhone or other
 * internal fields. contactStatus is computed here (server.js) and passed
 * into the db layer so database.js never needs to import config.js.
 */
app.get('/api/public/chats', (req, res) => {
  res.json(db.getPublishedChats(getContactStatus));
});

/**
 * Public: cast a vote for a chat. One vote per (chatId, voterId).
 */
app.post('/api/public/vote', voterIdentity, voteLimiter, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) {
      return res.status(400).json({ error: 'chatId is required' });
    }
    const result = await db.recordVote(chatId, req.voterId);
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.message === 'Already voted for this chat' ? 409
      : err.message.startsWith('Chat not found') ? 404
      : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * Public: signup form config - conversation topics and a coarse "bot status"
 * (night rest / weekend) computed server-side from Israel local time, since
 * a visitor's own browser clock/timezone can't be trusted for this.
 */
app.get('/api/public/config', (req, res) => {
  const config = getConfig();
  const { hour, weekdayNum } = getIsraelTime();
  res.json({
    topics: config.leaderboardTopics,
    botStatus: {
      isNight: isNightTime(),
      weekdayNum, // Sun=0 ... Sat=6
      hour
    }
  });
});

const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts, slow down and try again in a minute.' }
});

/**
 * Public: self-serve signup for the leaderboard. Requires explicit
 * consentAccepted (the visitor must actively check the "I agree my name and
 * chats will be public" box - never defaulted true). A filled honeypot
 * field is treated as a bot and silently accepted as a no-op.
 */
app.post('/api/public/signup', signupLimiter, async (req, res) => {
  try {
    const { phone, displayAlias, topic, consentAccepted, website } = req.body;

    if (website) {
      // Honeypot field: real visitors never see or fill this input.
      return res.json({ success: true });
    }
    if (consentAccepted !== true) {
      return res.status(400).json({ error: 'Explicit consent is required to sign up.' });
    }

    const config = getConfig();
    if (!config.botWhatsappNumber) {
      return res.status(500).json({ error: 'Bot WhatsApp number is not configured yet.' });
    }

    await db.registerLeaderboardSignup({ phone, displayAlias, topic });

    const greeting = `היי! זה ${displayAlias}, נרשמתי דרך העמוד${topic ? ` (${topic})` : ''} 👋`;
    const waLink = `https://wa.me/${config.botWhatsappNumber}?text=${encodeURIComponent(greeting)}`;
    res.json({ success: true, waLink });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: list all chats regardless of status (draft/published/archived),
 * each annotated with the live contactStatus (admin already sees
 * contactPhone here, so no serialization concerns).
 */
app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const chats = db.getAllChats().map(chat => ({
    ...chat,
    contactStatus: getContactStatus(chat.contactPhone)
  }));
  res.json(chats);
});

/**
 * Admin: add a new candidate chat for the leaderboard (starts as
 * draft + consentStatus 'pending' - must be explicitly approved before
 * it can be published).
 */
app.post('/api/admin/chats', requireAdmin, async (req, res) => {
  try {
    const { contactPhone, displayAlias, messages } = req.body;
    const newChat = await db.addChat({ contactPhone, displayAlias, messages });
    res.json({ success: true, chat: newChat });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: edit chat content/alias before publishing.
 */
app.put('/api/admin/chats/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateChat(req.params.id, req.body);
    res.json({ success: true, chat: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: record explicit consent decision for a chat's real-contact content.
 */
app.post('/api/admin/chats/:id/consent', requireAdmin, async (req, res) => {
  try {
    const updated = await db.setConsentStatus(req.params.id, req.body.consentStatus);
    res.json({ success: true, chat: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: publish an approved chat to the public leaderboard. Starts the
 * retention clock (publishedAt).
 */
app.post('/api/admin/chats/:id/publish', requireAdmin, async (req, res) => {
  try {
    const updated = await db.publishChat(req.params.id);
    res.json({ success: true, chat: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: archive (soft-delete) a chat - hides it from the public
 * leaderboard without removing it from disk.
 */
app.post('/api/admin/chats/:id/archive', requireAdmin, async (req, res) => {
  try {
    const updated = await db.archiveChat(req.params.id);
    res.json({ success: true, chat: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// STARTUP AND INITIALIZATION
// ----------------------------------------------------

async function startServer() {
  // 1. Initialize Database
  await db.init();

  // 2. Initialize Scheduler
  await scheduler.init();

  const config = getConfig();
  const PORT = config.port;

  const server = app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 AutoRI-Studio WhatsApp Warmup Agent is running!`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 Webhook URL: http://your-public-url/webhook`);
    console.log(`==================================================`);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('Shutting down server and scheduler...');
    scheduler.destroy();
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch(err => {
  console.error('Critical failure during server startup:', err);
  process.exit(1);
});
