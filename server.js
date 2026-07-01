import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import scheduler from './scheduler.js';
import { getConfig, isNightTime, getDailyQuota } from './config.js';
import { sendMessage, markRead, sendReaction, sendTypingState } from './evolution.js';
import { generateReply, generateGroupReply } from './gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
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
 * Webhook endpoint to receive events from Evolution API
 */
app.post(['/webhook', '/api/webhook'], async (req, res) => {
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

    const config = getConfig();
    if (!config.warmupEnabled) {
      console.log(`Warmup is disabled. Read receipt will be sent to ${phone} after delay, but reply skipped.`);
      setTimeout(async () => {
        try {
          await markRead(remoteJid, data.key);
        } catch (e) {
          console.error('Failed to mark read in disabled mode:', e);
        }
      }, 3000);
      return res.json({ status: 'success', detail: 'Read only, warmup disabled' });
    }

    // Check night rest mode (only if enabled in dashboard settings)
    if (config.nightRestEnabled && isNightTime()) {
      await scheduler.queueNightMessage(phone, messageText, contact.name);
      return res.json({ status: 'success', detail: 'Queued for morning' });
    }

    // Check if we should simulate being "busy" (ghosting) for this reply
    const shouldDelay = config.busySimulationEnabled && Math.random() < config.busySimulationChance;
    if (shouldDelay) {
      const delayMinutes = Math.floor(Math.random() * (config.maxBusyDelayMinutes - config.minBusyDelayMinutes + 1)) + config.minBusyDelayMinutes;
      const sendAfter = new Date(Date.now() + delayMinutes * 60000).toISOString();
      
      await scheduler.queueDelayedReply(phone, remoteJid, messageText, contact.name, data.key, sendAfter);
      await db.addLog('info', `Simulating busy/away status: Delaying reply to ${contact.name || phone} by ${delayMinutes} minutes (Will reply around ${new Date(sendAfter).toLocaleTimeString('he-IL')}).`, messageText, phone);
      return res.json({ status: 'success', detail: `Delayed reply by ${delayMinutes} mins` });
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
        const replyText = await generateReply(contact.name, messageText, history, config.currentDay);
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
 * Get current configuration, status, stats for today, and queued item counts
 */
app.get('/api/status', (req, res) => {
  const config = getConfig();
  const today = db.getTodayDateString();
  const stats = db.getStatsForDate(today);
  const dailyQuota = getDailyQuota();
  
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
    nightQueueLength: (config.nightQueue || []).length,
    isNight: isNightTime()
  });
});

/**
 * Save configuration settings
 */
app.post('/api/settings', async (req, res) => {
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

    await db.addLog('success', 'System configurations updated via dashboard.');
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger a manual WhatsApp status post (image or text)
 */
app.post('/api/status/trigger', async (req, res) => {
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
 * Get all guided contacts
 */
app.get('/api/contacts', (req, res) => {
  res.json(db.getContacts());
});

/**
 * Add a new guided contact
 */
app.post('/api/contacts', async (req, res) => {
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
app.put('/api/contacts/:phone', async (req, res) => {
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
app.delete('/api/contacts/:phone', async (req, res) => {
  try {
    const removed = await db.deleteContact(req.params.phone);
    await db.addLog('warning', `Deleted contact: ${removed.name} (${req.params.phone})`);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Get system logs
 */
app.get('/api/logs', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : 50;
  res.json(db.getLogs(limit));
});

/**
 * Trigger manual active starter
 */
app.post('/api/test/starter', async (req, res) => {
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
 * Useful for validating response logic offline.
 */
app.post('/api/test/incoming', async (req, res) => {
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
        'Content-Type': 'application/json'
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
    console.log(`🚀 Yozma WhatsApp Warmup Agent is running!`);
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
