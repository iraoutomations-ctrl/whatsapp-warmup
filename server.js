import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { fileURLToPath } from 'url';
import db from './database.js';
import schedulerManager from './scheduler.js';
import { getConfig, getGlobalConfig, isNightTime, getDailyQuota, getIsraelTime, computeDynamicContactCap, getContactStatus, isDailyQuotaReached } from './config.js';
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
 * Webhook endpoint to receive events from Evolution API. Each bot instance
 * (WhatsApp number) has its own separate Evolution API deployment, so the
 * URL itself identifies which instance a payload belongs to via :instanceId.
 * The no-instanceId variants are a legacy alias that resolves to the
 * current default instance - kept only until every configured instance's
 * Evolution webhook config is confirmed pointed at its own /:instanceId/
 * URL (see Phase 7 cleanup in the multi-tenant plan).
 * If a webhookSecret is configured for the resolved instance, requests must
 * present it via the URL path segment, an 'x-webhook-secret' header, or a
 * 'secret' query param - otherwise anyone who finds this URL could inject
 * fake incoming messages.
 *
 * IMPORTANT: the instanceId-aware form is always exactly 3 path segments
 * (/webhook/:instanceId/:secret), never /webhook/:instanceId alone - a
 * 2-segment form would be indistinguishable from (and permanently shadowed
 * by) the legacy 2-segment /webhook/:secret route below, since Express
 * matches by segment shape, not by param name. When an instance has no
 * secret configured, use any placeholder value for that segment.
 */
app.post(['/webhook/:instanceId/:secret', '/api/webhook/:instanceId/:secret', '/webhook/:secret', '/api/webhook/:secret', '/webhook', '/api/webhook'], async (req, res) => {
  let instance;
  if (req.params.instanceId) {
    instance = db.getInstanceById(req.params.instanceId);
    if (!instance) {
      return res.status(404).json({ error: `Unknown bot instance: ${req.params.instanceId}` });
    }
  } else {
    instance = db.getDefaultInstance();
    if (!instance) {
      return res.status(500).json({ error: 'No default bot instance is configured.' });
    }
  }

  const config = getConfig(instance.id);
  if (config.webhookSecret) {
    const providedSecret = req.params.secret || req.headers['x-webhook-secret'] || req.query.secret;
    if (providedSecret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing webhook secret' });
    }
  } else {
    console.warn(`WARNING: No webhookSecret configured for instance "${instance.label}" (${instance.id}) - its webhook is publicly reachable without authentication. Set one in its instance settings.`);
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
      // Always mark group messages as read (simulates active device consumption)
      await markRead(config, remoteJid);

      // Check if group responses are active (Only in Week 2, currentDay >= 8)
      if (config.warmupEnabled && config.groupsEnabled && config.currentDay >= 8) {
        const today = db.getTodayDateString();
        const todayStats = db.getStatsForInstanceDate(instance.id, today);

        // Check if we haven't hit the daily group reply quota
        if (todayStats.group < config.groupReplyLimitPerDay) {
          // Ask Gemini if this warrants a response
          const decision = await generateGroupReply(senderName, messageText);

          if (decision && decision.toUpperCase() !== 'SKIP') {
            console.log(`Responding to group (${remoteJid}) message: "${decision}"`);
            await db.addLog('info', `Group reaction determined for message from ${senderName}`, messageText, remoteJid, false, instance.id);

            // Wait a random delay (4 to 10 seconds) to simulate reading and writing in group
            const groupTypeDelay = Math.floor(Math.random() * 6000) + 4000;
            setTimeout(async () => {
              await sendMessage(config, remoteJid, decision, false);
              await db.incrementInstanceStat(instance.id, 'group'); // Increment group reply count
              await db.addLog('success', `Reacted in group ${remoteJid}: "${decision}"`, '', '', false, instance.id);
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
      await db.addLog('info', `Ignored message from unguided number: ${phone}`, messageText, phone, false, instance.id);
      return res.json({ status: 'ignored', reason: 'Not an active guided contact' });
    }

    // Guard against a misconfigured webhook: this contact belongs to a
    // different instance than the one this payload arrived on. Replying
    // here would use the wrong number's persona/quota/day state.
    if (contact.instanceId && contact.instanceId !== instance.id) {
      console.warn(`Webhook mismatch: contact ${phone} belongs to instance ${contact.instanceId}, but this message arrived on instance ${instance.id}.`);
      await db.addLog('warning', `Webhook instance mismatch for ${phone}: contact belongs to a different instance. Ignored.`, messageText, phone, false, instance.id);
      return res.json({ status: 'ignored', reason: 'Contact belongs to a different bot instance' });
    }

    // Log the incoming message and update statistics immediately
    await db.incrementInstanceStat(instance.id, 'incoming');
    await db.addLog('message', `Received: ${messageText}`, messageText, phone, false, instance.id);

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
    // separate sweep job is needed. pendingOptOuts lives on the instance
    // record now (it's this number's own pending-request queue).
    const OPT_OUT_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
    const activePendingOptOuts = (config.pendingOptOuts || [])
      .filter(p => Date.now() - new Date(p.requestedAt).getTime() < OPT_OUT_CONFIRM_WINDOW_MS);
    const pendingOptOut = activePendingOptOuts.find(p => p.phone === phone);

    if (pendingOptOut) {
      const isConfirmed = messageText.trim().replace(/[.!?,]/g, '') === 'כן תפסיק';
      await db.updateInstance(instance.id, { pendingOptOuts: activePendingOptOuts.filter(p => p.phone !== phone) });
      if (isConfirmed) {
        await db.optOutContact(phone);
        await sendMessage(config, phone, 'סבבה, מבין. ביי 👋 אם תתגעגע אתה יודע איפה למצוא אותי');
        await db.addLog('success', `Contact ${contact.name || phone} opted out via chat command.`, '', '', false, instance.id);
        return res.json({ status: 'success', detail: 'Contact opted out' });
      }
      // Not a confirmation - pending already cleared above, fall through to normal reply handling.
    } else if (messageText.includes('תפסיק לכתוב לי')) {
      await db.updateInstance(instance.id, { pendingOptOuts: [...activePendingOptOuts, { phone, requestedAt: new Date().toISOString() }] });
      await sendMessage(config, phone, "רגע רגע יא חבר, אתה רציני? 😢 תכתוב לי 'כן תפסיק' ואני נעלם מהחיים שלך לתמיד");
      return res.json({ status: 'success', detail: 'Opt-out confirmation requested' });
    }

    if (!config.warmupEnabled) {
      console.log(`Warmup is disabled for instance ${instance.id}. Read receipt will be sent to ${phone} after delay, but reply skipped.`);
      setTimeout(async () => {
        try {
          await sendTypingState(config, phone, 'available', 1500);
          await markRead(config, remoteJid, data.key);
        } catch (e) {
          console.error('Failed to mark read in disabled mode:', e);
        }
      }, 3000);
      return res.json({ status: 'success', detail: 'Read only, warmup disabled' });
    }

    // Check emergency hard ceiling for incoming replies (1.5x daily quota)
    // Regular dailyQuota stops active warmup initiations in scheduler, but we allow replying to existing conversations up to 1.5x quota!
    const todayStr = db.getTodayDateString();
    const stats = db.getStatsForInstanceDate(instance.id, todayStr);
    const dailyQuota = getDailyQuota(instance.id);
    const emergencyQuota = Math.floor(dailyQuota * 1.5);
    if (stats.outgoing >= emergencyQuota) {
      await handleLimitStop(config, phone, remoteJid, data.key, contact.name, `Emergency quota reached (${stats.outgoing}/${emergencyQuota})`);
      return res.json({ status: 'success', detail: 'Emergency quota reached' });
    }

    // Check per-contact daily conversation depth cap with human variance (-1, 0, +1 around base limit)
    const contactCap = computeDynamicContactCap(phone, instance.id);
    if (contactCap.reached) {
      await handleLimitStop(config, phone, remoteJid, data.key, contact.name, `Conversation depth reached (${contactCap.count}/${contactCap.cap})`);
      return res.json({ status: 'success', detail: 'Max daily contact depth reached' });
    }

    // Check night rest mode (only if enabled in dashboard settings)
    if (config.nightRestEnabled && isNightTime(instance.id)) {
      await schedulerManager.getWorker(instance.id).queueNightMessage(phone, messageText, contact.name, data.key, remoteJid);
      return res.json({ status: 'success', detail: 'Queued for morning' });
    }

    // Check if we should simulate being "busy" (ghosting) for this reply
    const delayedReplies = config.delayedReplies || [];
    const existingReplyIdx = delayedReplies.findIndex(r => r.phone === phone);
    const isAlreadyDelayed = existingReplyIdx !== -1;

    const shouldDelay = config.busySimulationEnabled && (isAlreadyDelayed || Math.random() < config.busySimulationChance);
    if (shouldDelay) {
      if (isAlreadyDelayed) {
        // Update the queued reply with the latest message text and key
        delayedReplies[existingReplyIdx].messageText = messageText;
        delayedReplies[existingReplyIdx].msgKey = data.key;
        await db.updateInstance(instance.id, { delayedReplies });
        await db.addLog('info', `Contact ${contact.name || phone} is already in busy/away delay. Appending new message to queue.`, messageText, phone, false, instance.id);
      } else {
        const delayMinutes = Math.floor(Math.random() * (config.maxBusyDelayMinutes - config.minBusyDelayMinutes + 1)) + config.minBusyDelayMinutes;
        const sendAfter = new Date(Date.now() + delayMinutes * 60000).toISOString();

        await schedulerManager.getWorker(instance.id).queueDelayedReply(phone, remoteJid, messageText, contact.name, data.key, sendAfter);
        await db.addLog('info', `Simulating busy/away status: Delaying reply to ${contact.name || phone} by ${delayMinutes} minutes (Will reply around ${new Date(sendAfter).toLocaleTimeString('he-IL')}).`, messageText, phone, false, instance.id);
      }
      return res.json({ status: 'success', detail: `Delayed reply` });
    }

    // Process the humanized reply sequence asynchronously in the background
    // to return the HTTP response immediately to the Evolution API webhook dispatcher
    setTimeout(async () => {
      try {
        await db.addLog('info', `Starting humanized reply sequence for ${phone}`, '', '', false, instance.id);

        // 1. Wait a random human delay (3 to 7 seconds) before opening the app
        const readDelay = Math.floor(Math.random() * 4000) + 3000;
        console.log(`Delaying app open simulation for ${phone} by ${readDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, readDelay));

        // 2. Go "Online" (available) to simulate opening the app
        await db.addLog('info', `Simulating user online (available) for ${phone}`, '', '', false, instance.id);
        await sendTypingState(config, phone, 'available', 1500);

        // 3. Mark message as read (V כחול)
        await db.addLog('info', `Marking message as read (blue checks) for ${phone}`, '', '', false, instance.id);
        await markRead(config, remoteJid, data.key);

        // 4. Wait a short delay before starting to type (simulate reading: 1.5 seconds)
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 5. Generate natural response using Gemini
        await db.addLog('info', `Calling Gemini to generate reply for ${phone}`, '', '', false, instance.id);
        const logs = db.getLogs().filter(log => log.phone === phone);
        const history = logs.slice(0, 10).reverse();
        const replyText = await generateReply(contact.name, messageText, history, config.currentDay, contact.notes);
        await db.addLog('info', `Gemini response generated for ${phone}: "${replyText}"`, '', '', false, instance.id);

        // 6. Send reaction or message reply
        const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
        if (reactionMatch) {
          const emoji = reactionMatch[1].trim();
          if (data.key?.id) {
            await db.addLog('info', `Sending emoji reaction "${emoji}" to ${phone}`, '', '', false, instance.id);
            const success = await sendReaction(config, remoteJid, emoji, data.key);
            if (!success) {
              // Fallback to normal text message containing the emoji
              console.log(`sendReaction failed. Falling back to sending emoji "${emoji}" as text.`);
              await sendMessage(config, phone, emoji, true);
            }
          }
        } else {
          // sendMessage will simulate typing based on text length (2s - 6s)
          await db.addLog('info', `Sending text reply to ${phone}`, '', '', false, instance.id);
          await sendMessage(config, phone, replyText, true);
        }

        // 7. Go "Offline" (unavailable) to simulate closing the app
        await db.addLog('info', `Simulating user offline (unavailable) for ${phone}`, '', '', false, instance.id);
        await sendTypingState(config, phone, 'unavailable', 500);
      } catch (err) {
        console.error('Error in asynchronous reply pipeline:', err);
        await db.addLog('error', `Async reply pipeline failed: ${err.message}`, '', '', false, instance.id);
      }
    }, 100);

    return res.json({ status: 'success', type: 'queued_reply' });
  } catch (error) {
    console.error('Error handling webhook message:', error);
    await db.addLog('error', `Webhook handler failed: ${error.message}`, '', '', false, instance.id);
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
 * Resolves an instanceId from a request (?instanceId= query param), falling
 * back to the current default instance. This keeps every route below
 * working exactly as before for the one existing (now default) instance
 * without requiring the admin UI to already know about multi-tenancy - the
 * Instances tab (a later step) is what actually lets an admin pick a
 * specific non-default instance via this same param.
 */
function resolveInstanceOrDefault(req) {
  const requested = req.query.instanceId || req.body?.instanceId;
  if (requested) {
    const inst = db.getInstanceById(requested);
    if (inst) return inst;
  }
  return db.getDefaultInstance();
}

/**
 * Get current configuration, status, stats for today, and queued item counts
 * for one bot instance (defaults to the default instance if none specified).
 */
app.get('/api/status', (req, res) => {
  const instance = resolveInstanceOrDefault(req);
  if (!instance) {
    return res.status(500).json({ error: 'No bot instance is configured.' });
  }
  const instanceConfig = getConfig(instance.id);
  const globalConfig = getGlobalConfig();
  const config = sanitizeConfigForPublic({ ...globalConfig, ...instanceConfig });
  const today = db.getTodayDateString();
  const stats = db.getStatsForInstanceDate(instance.id, today);
  const dailyQuota = getDailyQuota(instance.id);

  res.json({
    instanceId: instance.id,
    config,
    stats: {
      todayDate: today,
      incoming: stats.incoming,
      outgoing: stats.outgoing,
      group: stats.group,
      total: stats.total,
      quota: dailyQuota
    },
    nightQueueLength: (instanceConfig.nightQueue || []).length,
    delayedReplies: instanceConfig.delayedReplies || [],
    nightQueue: instanceConfig.nightQueue || [],
    dailyQuotaReached: isDailyQuotaReached(instance.id),
    isNight: isNightTime(instance.id)
  });
});

/**
 * Middleware to verify Admin PIN for state mutating actions
 */
function requireAdmin(req, res, next) {
  const config = getGlobalConfig();
  const providedPin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin;

  if (!providedPin || providedPin !== config.adminPin) {
    return res.status(403).json({ error: 'Unauthorized: Admin PIN required to perform this action.' });
  }
  next();
}

/**
 * Verify if provided PIN matches adminPin
 */
app.post('/api/verify-pin', (req, res) => {
  const config = getGlobalConfig();
  const providedPin = req.headers['x-admin-pin'] || req.body?.pin;
  res.json({ success: providedPin === config.adminPin });
});

/**
 * Admin-only: fetch the raw secret values (Gemini key is global; Evolution
 * credentials belong to one specific instance) so the settings form can be
 * populated. Never exposed via the public /api/status route.
 */
app.get('/api/settings/secrets', requireAdmin, (req, res) => {
  const globalConfig = getGlobalConfig();
  const instance = resolveInstanceOrDefault(req);
  const instanceConfig = instance ? getConfig(instance.id) : null;
  res.json({
    geminiApiKey: globalConfig.geminiApiKey,
    evolutionToken: instanceConfig?.evolutionToken || '',
    webhookSecret: instanceConfig?.webhookSecret || ''
  });
});

/**
 * Save GLOBAL configuration settings only (Gemini key, admin PIN,
 * leaderboard-wide policy). Per-instance settings (Evolution
 * credentials, warmup day/quota, night rest, etc.) now go through
 * PUT /api/instances/:id below - see the Instances admin tab.
 */
app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const allowedGlobalFields = ['geminiApiKey', 'adminPin', 'leaderboardRetentionDays', 'leaderboardMinVotesToKeep', 'leaderboardTopNAlwaysKept', 'leaderboardMinMessagesToPublish', 'leaderboardTopics'];
    const globalUpdates = {};
    for (const field of allowedGlobalFields) {
      if (req.body[field] !== undefined) globalUpdates[field] = req.body[field];
    }
    const updated = await db.saveSettings(globalUpdates);

    await db.addLog('success', 'Global configurations updated via dashboard.');
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Reset all logs, stats, contact counters, and every instance's queues
 */
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    // 1. Clear logs
    db.logs = [];
    await db._saveFile('logs.json', db.logs);

    // 2. Clear stats (works regardless of the per-instance nesting shape)
    db.stats = {};
    await db._saveFile('stats.json', db.stats);

    // 3. Reset contact counters
    db.contacts = db.contacts.map(c => ({
      ...c,
      messageCount: 0,
      lastInteractionAt: null
    }));
    await db._saveFile('contacts.json', db.contacts);

    // 4. Clear every instance's queues (nightQueue/delayedReplies now live
    // on the instance record, not the old global settings blob)
    for (const inst of db.getInstances()) {
      await db.updateInstance(inst.id, { nightQueue: [], delayedReplies: [] });
    }

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
    const instance = db.getInstanceById(contact.instanceId) || db.getDefaultInstance();
    const config = getConfig(instance.id);

    // 1. Send the actual message via Evolution API (this also logs to DB and updates contact stats)
    await sendMessage(config, phone, message, true);

    // 2. Override/Clear any queued replies for this contact (both queues
    // live on the contact's own instance record)
    let queueChanged = false;

    let delayedReplies = config.delayedReplies || [];
    const delayedIdx = delayedReplies.findIndex(r => r.phone === phone);
    if (delayedIdx !== -1) {
      delayedReplies = delayedReplies.filter((_, i) => i !== delayedIdx);
      queueChanged = true;
    }

    let nightQueue = config.nightQueue || [];
    const nightIdx = nightQueue.findIndex(q => q.phone === phone);
    if (nightIdx !== -1) {
      nightQueue = nightQueue.filter((_, i) => i !== nightIdx);
      queueChanged = true;
    }

    if (queueChanged) {
      await db.updateInstance(instance.id, { delayedReplies, nightQueue });
      await db.addLog('info', `Human override: Cleared queued automated replies for ${contact.name || phone} due to manual message.`, '', phone, false, instance.id);
    }

    res.json({ success: true, message: 'Message sent and queues cleared' });
  } catch (err) {
    console.error('Failed to send manual message:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger a manual WhatsApp status post (image or text) for one instance
 * (defaults to the default instance) - status posting is inherently
 * per-WhatsApp-account.
 */
app.post('/api/status/trigger', requireAdmin, async (req, res) => {
  try {
    const instance = resolveInstanceOrDefault(req);
    if (!instance) {
      return res.status(500).json({ error: 'No bot instance is configured.' });
    }
    const worker = schedulerManager.getWorker(instance.id);
    if (!worker) {
      return res.status(500).json({ error: `No running scheduler worker for instance ${instance.id}.` });
    }
    const result = await worker.triggerManualStatusPost();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Perform active connection diagnostics for Gemini (global) and Evolution
 * (per-instance, defaults to the default instance) APIs
 */
app.get('/api/test-connection', async (req, res) => {
  const instance = resolveInstanceOrDefault(req);
  const config = instance ? getConfig(instance.id) : null;
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
  if (!config) {
    report.evolution.error = 'No bot instance is configured.';
  } else if (!config.evolutionUrl || !config.evolutionToken || !config.evolutionInstance) {
    report.evolution.error = `Evolution credentials are not configured for instance "${config.label}".`;
  } else {
    try {
      const cleanUrl = config.evolutionUrl.replace(/\/$/, '');
      const url = `${cleanUrl}/instance/connectionState/${config.evolutionInstance}`;
      console.log(`Checking Evolution connection state for instance ${config.id}: ${url}`);

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
    instanceId: instance?.id || null,
    report
  });
});

// ----------------------------------------------------
// BOT INSTANCES (WhatsApp numbers) - admin only
// ----------------------------------------------------

/**
 * Strips secrets from an instance record before it's sent to the admin UI's
 * list view (the dedicated secrets route below returns them on demand).
 */
function sanitizeInstanceForAdmin(instance) {
  const { evolutionToken, webhookSecret, ...rest } = instance;
  return { ...rest, hasEvolutionToken: !!evolutionToken, hasWebhookSecret: !!webhookSecret };
}

app.get('/api/instances', requireAdmin, (req, res) => {
  res.json(db.getInstances().map(sanitizeInstanceForAdmin));
});

app.get('/api/instances/:id/secrets', requireAdmin, (req, res) => {
  const instance = db.getInstanceById(req.params.id);
  if (!instance) {
    return res.status(404).json({ error: 'Instance not found' });
  }
  res.json({
    evolutionUrl: instance.evolutionUrl,
    evolutionToken: instance.evolutionToken,
    evolutionInstance: instance.evolutionInstance,
    webhookSecret: instance.webhookSecret
  });
});

app.post('/api/instances', requireAdmin, async (req, res) => {
  try {
    const newInstance = await db.addInstance(req.body);
    await schedulerManager.startWorkerForInstance(newInstance.id);
    await db.addLog('success', `Added bot instance: ${newInstance.label} (${newInstance.id})`);
    res.json({ success: true, instance: sanitizeInstanceForAdmin(newInstance) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/instances/:id', requireAdmin, async (req, res) => {
  try {
    const before = db.getInstanceById(req.params.id);
    const updated = await db.updateInstance(req.params.id, req.body);

    // If warmup was toggled ON for this instance, run its active warmup
    // cycle within 5 seconds for responsive testing (mirrors the old
    // single-instance /api/settings behavior).
    const worker = schedulerManager.getWorker(req.params.id);
    if (worker) {
      if (req.body.warmupEnabled === true && before?.warmupEnabled !== true) {
        console.log(`Warmup toggled ON for instance ${req.params.id}. Rescheduling next run to execute in 5 seconds...`);
        await worker.scheduleNextWarmup(5000);
      } else if (req.body.activeMinIntervalMinutes !== undefined || req.body.activeMaxIntervalMinutes !== undefined) {
        await worker.scheduleNextWarmup();
      }
      if (req.body.busySimulationEnabled === false && before?.busySimulationEnabled !== false) {
        console.log(`Busy simulation toggled OFF for instance ${req.params.id}. Immediately processing all delayed replies...`);
        worker.processDelayedReplies();
      }
    }

    res.json({ success: true, instance: sanitizeInstanceForAdmin(updated) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/instances/:id/set-default', requireAdmin, async (req, res) => {
  try {
    const updated = await db.setDefaultInstance(req.params.id);
    await db.addLog('success', `Instance "${updated.label}" set as default.`);
    res.json({ success: true, instance: sanitizeInstanceForAdmin(updated) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/instances/:id', requireAdmin, async (req, res) => {
  try {
    const removed = await db.deleteInstance(req.params.id);
    schedulerManager.stopWorkerForInstance(req.params.id);
    await db.addLog('warning', `Deleted bot instance: ${removed.label} (${removed.id})`);
    res.json({ success: true, removed: sanitizeInstanceForAdmin(removed) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get all guided contacts (contains phone numbers/PII - admin only)
 */
app.get('/api/contacts', requireAdmin, (req, res) => {
  res.json(db.getContacts());
});

/**
 * Add a new guided contact. instanceId is optional - defaults to the
 * current default instance (see db.addContact).
 */
app.post('/api/contacts', requireAdmin, async (req, res) => {
  try {
    const { phone, name, notes, enabled, instanceId } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Clean number: keep digits only
    const cleanPhone = phone.replace(/\D/g, '');
    const newContact = await db.addContact({ phone: cleanPhone, name, notes, enabled, instanceId });

    await db.addLog('success', `Added contact: ${name} (${cleanPhone})`, '', '', false, newContact.instanceId);
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

    const contact = db.getContacts().find(c => c.phone === phone);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    const worker = schedulerManager.getWorker(contact.instanceId) || schedulerManager.getWorker(db.getDefaultInstance()?.id);
    if (!worker) {
      return res.status(500).json({ error: 'No running scheduler worker for this contact\'s instance.' });
    }

    const message = await worker.triggerManualStarter(phone);
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Simulator Endpoint: Mock an incoming message from a contact/group.
 * Hits the legacy no-instanceId webhook alias (resolves to the default
 * instance) unless an instanceId is explicitly provided.
 */
app.post('/api/test/incoming', requireAdmin, async (req, res) => {
  try {
    const { phone, message, isGroup, senderName, instanceId } = req.body;

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
    const globalConfig = getGlobalConfig();
    const serverPort = globalConfig.port;
    const targetInstance = instanceId ? db.getInstanceById(instanceId) : db.getDefaultInstance();
    if (!targetInstance) {
      return res.status(500).json({ error: 'No bot instance is configured.' });
    }
    const webhookSecret = getConfig(targetInstance.id).webhookSecret;
    // Must always be exactly 3 path segments (webhook/instanceId/secret) -
    // a 2-segment /webhook/:instanceId would be indistinguishable from (and
    // permanently shadowed by) the legacy 2-segment /webhook/:secret route
    // registered below, since Express can't tell them apart by shape alone.
    // When no real secret is configured, the segment is just an unchecked
    // placeholder - the handler only validates it when config.webhookSecret
    // is actually set.
    const webhookPath = `/webhook/${targetInstance.id}/${webhookSecret || 'no-secret-configured'}`;

    const response = await fetch(`http://localhost:${serverPort}${webhookPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(webhookSecret ? { 'x-webhook-secret': webhookSecret } : {})
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
 * filtered through db.toPublicChat() - never contactPhone, instanceId, or
 * other internal fields, regardless of which underlying bot number actually
 * handled the conversation. contactStatus is computed here (server.js) and
 * passed into the db layer so database.js never needs to import config.js.
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
 * Public: signup form config - conversation topics (global) and a coarse
 * "bot status" (night rest / weekend) computed server-side from Israel
 * local time, since a visitor's own browser clock/timezone can't be
 * trusted for this. Sourced from the default instance, since the public
 * page presents Nehorai as one unified persona with one coherent
 * awake/asleep signal, regardless of which instance ends up handling any
 * given conversation.
 */
app.get('/api/public/config', (req, res) => {
  const globalConfig = getGlobalConfig();
  const defaultInstance = db.getDefaultInstance();
  const { hour, weekdayNum } = getIsraelTime();
  res.json({
    topics: globalConfig.leaderboardTopics,
    botStatus: {
      isNight: defaultInstance ? isNightTime(defaultInstance.id) : false,
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
 * Load-balances new leaderboard signups across active-warmup instances so
 * no single client number gets hammered while others sit idle - picks the
 * non-default, warmup-enabled, currently-eligible (not resting, not at
 * today's quota) instance with the most remaining quota today. Falls back
 * to the default instance if none qualify (all client numbers resting/
 * capped/disabled, or none exist yet) - the whole point of the default
 * number is that the public persona is never "unavailable".
 *
 * Only matters for a BRAND-NEW phone - a returning visitor always keeps
 * their original instance regardless of what this returns, enforced inside
 * db.registerLeaderboardSignup itself.
 */
function pickInstanceForSignup() {
  const today = db.getTodayDateString();
  const remainingQuota = (inst) => getDailyQuota(inst.id) - db.getStatsForInstanceDate(inst.id, today).outgoing;

  const candidates = db.getInstances().filter(inst => {
    if (inst.isDefault) return false;
    const config = getConfig(inst.id);
    if (!config.warmupEnabled) return false;
    if (config.nightRestEnabled && isNightTime(inst.id)) return false;
    if (isDailyQuotaReached(inst.id)) return false;
    return true;
  });

  if (candidates.length === 0) {
    return db.getDefaultInstance();
  }

  return candidates.reduce((best, inst) => remainingQuota(inst) > remainingQuota(best) ? inst : best);
}

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

    const targetInstance = pickInstanceForSignup();
    if (!targetInstance || !targetInstance.phone) {
      return res.status(500).json({ error: 'Bot WhatsApp number is not configured yet.' });
    }

    const contact = await db.registerLeaderboardSignup({ phone, displayAlias, topic, instanceId: targetInstance.id });
    const assignedInstance = db.getInstanceById(contact.instanceId) || targetInstance;

    const greeting = `היי! זה ${displayAlias}, נרשמתי דרך העמוד${topic ? ` (${topic})` : ''} 👋`;
    const waLink = `https://wa.me/${assignedInstance.phone}?text=${encodeURIComponent(greeting)}`;
    res.json({ success: true, waLink });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Admin: list all chats regardless of status (draft/published/archived),
 * each annotated with the live contactStatus (admin already sees
 * contactPhone/instanceId here, so no serialization concerns).
 */
app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const chats = db.getAllChats().map(chat => ({
    ...chat,
    contactStatus: getContactStatus(chat.contactPhone, chat.instanceId)
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

  // 2. Initialize Scheduler (one worker per bot instance + the global
  // leaderboard sweep loop)
  await schedulerManager.init();

  const PORT = getGlobalConfig().port;

  const server = app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 AutoRI-Studio WhatsApp Warmup Agent is running!`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 Webhook URL: http://your-public-url/webhook/:instanceId`);
    console.log(`==================================================`);
  });

  // Graceful shutdown handling
  const shutdown = () => {
    console.log('Shutting down server and scheduler...');
    schedulerManager.destroy();
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
