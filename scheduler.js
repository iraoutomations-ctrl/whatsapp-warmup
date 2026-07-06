import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import db from './database.js';
import { getConfig, isNightTime, isWeekend, getDailyQuota, getIsraelTime } from './config.js';
import { generateStarter, generateReply, generateStatusText, generateStatusCaption, generateImagePrompt } from './gemini.js';
import { sendMessage, sendStatusText, sendStatusImage, sendStatus, markRead, sendReaction, sendTypingState } from './evolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class WarmupScheduler {
  constructor() {
    this.activeTimeoutId = null;
    this.queueIntervalId = null;
    this.dayCheckIntervalId = null;
    this.spontaneousCheckInTimeoutId = null;
  }

  async init() {
    console.log('Initializing Warmup Scheduler...');
    
    // Start the active warmup scheduling loop
    await this.scheduleNextWarmup();

    // Start background processing interval for night queue (check every 60 seconds)
    this.queueIntervalId = setInterval(async () => {
      await this.processNightQueue();
      await this.processDelayedReplies();
    }, 60 * 1000);

    // Start day progression tracker and daily status poster (check every hour)
    this.dayCheckIntervalId = setInterval(() => {
      this.checkDayProgression();
      this.checkAndPostDailyStatus();
    }, 60 * 60 * 1000);

    // Run a quick status check 10 seconds after startup
    setTimeout(() => this.checkAndPostDailyStatus(), 10 * 1000);

    // Start random spontaneous check-ins (opening WhatsApp without messaging)
    this.scheduleNextSpontaneousCheckIn(true); // First run is 15 seconds for testing

    await db.addLog('info', 'Warmup Scheduler initialized and active loop scheduled.');
  }

  /**
   * Schedules the next active warmup starter at a random interval.
   */
  async scheduleNextWarmup(forcedDelayMs = null) {
    // Clear any existing timeout
    if (this.activeTimeoutId) {
      clearTimeout(this.activeTimeoutId);
    }

    const config = getConfig();
    let delayMs = 0;

    if (forcedDelayMs !== null) {
      delayMs = forcedDelayMs;
    } else {
      // Calculate random minutes with safety swap in case min > max
      let min = Math.max(1, config.activeMinIntervalMinutes || 30);
      let max = Math.max(1, config.activeMaxIntervalMinutes || 90);
      if (min > max) {
        const temp = min;
        min = max;
        max = temp;
      }
      const randomMinutes = Math.floor(Math.random() * (max - min + 1)) + min;
      
      // If it's the weekend, scale down frequency by 5x (80% reduction)
      const adjustedMinutes = isWeekend() ? randomMinutes * 5 : randomMinutes;
      
      delayMs = adjustedMinutes * 60 * 1000;
    }

    let nextRunTime = new Date(Date.now() + delayMs);

    // If the scheduled time falls inside the night rest period, roll it forward past morning wake up
    if (config.nightRestEnabled && isNightTime(nextRunTime)) {
      let guard = 0;
      while (isNightTime(nextRunTime) && guard < 100) {
        nextRunTime = new Date(nextRunTime.getTime() + 15 * 60 * 1000);
        guard++;
      }
      // Add a random 5 to 25 minutes offset into the morning
      const morningOffset = (Math.floor(Math.random() * 21) + 5) * 60 * 1000;
      nextRunTime = new Date(nextRunTime.getTime() + morningOffset);
      delayMs = Math.max(1000, nextRunTime.getTime() - Date.now());
    }

    console.log(`Next active warmup starter scheduled for: ${nextRunTime.toLocaleTimeString()}`);

    // Pre-calculate target contact for dashboard display
    const contacts = db.getContacts().filter(c => c.enabled);
    let nextTarget = null;
    if (contacts.length > 0) {
      const sortedContacts = [...contacts].sort((a, b) => {
        if (!a.lastInteractionAt) return -1;
        if (!b.lastInteractionAt) return 1;
        return new Date(a.lastInteractionAt) - new Date(b.lastInteractionAt);
      });
      const candidates = sortedContacts.slice(0, Math.min(2, sortedContacts.length));
      nextTarget = candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Save planned schedule and target details to DB settings
    await db.saveSettings({
      nextActiveWarmupAt: nextRunTime.toISOString(),
      nextActiveWarmupTargetPhone: nextTarget ? nextTarget.phone : null,
      nextActiveWarmupTargetName: nextTarget ? nextTarget.name : null
    });

    this.activeTimeoutId = setTimeout(async () => {
      try {
        await this.runActiveWarmupCycle();
      } catch (err) {
        console.error('Error running active warmup cycle:', err);
      } finally {
        // Reschedule
        await this.scheduleNextWarmup();
      }
    }, delayMs);
  }

  /**
   * Executes a single active warmup cycle:
   * - Checks rules (enabled, night rest, quota limits)
   * - Picks a contact
   * - Generates a starter message using Gemini
   * - Sends it
   */
  async runActiveWarmupCycle(excludePhones = []) {
    const config = getConfig();

    if (!config.warmupEnabled) {
      console.log('Active warmup cycle skipped: Warmup is currently disabled.');
      return false;
    }

    if (config.nightRestEnabled && isNightTime()) {
      console.log('Active warmup loop: Night rest mode active. Skipping active message.');
      return false;
    }

    // Check daily message quota
    const today = db.getTodayDateString();
    const stats = db.getStatsForDate(today);
    const dailyQuota = getDailyQuota();

    if (stats.outgoing >= dailyQuota) {
      console.log(`Active warmup cycle skipped: Daily outgoing message quota reached (${stats.outgoing}/${dailyQuota}).`);
      await db.addLog('warning', `Active warmup skipped: Daily quota limit reached (${stats.outgoing}/${dailyQuota}).`);
      return false;
    }

    // Pick a contact (prefer the pre-scheduled target contact if not excluded)
    const contacts = db.getContacts().filter(c => c.enabled && !excludePhones.includes(c.phone));
    if (contacts.length === 0) {
      console.log('Active warmup cycle aborted: No available candidate contacts left.');
      if (excludePhones.length > 0) {
        await db.addLog('warning', 'Active warmup cycle aborted: All candidate contacts failed sending.');
      } else {
        await db.addLog('warning', 'Active warmup skipped: No enabled contacts found.');
      }
      return false;
    }

    let targetContact = null;
    if (config.nextActiveWarmupTargetPhone && excludePhones.length === 0) {
      targetContact = contacts.find(c => c.phone === config.nextActiveWarmupTargetPhone);
    }

    if (!targetContact) {
      // Pick contact with the least recent interaction, or random
      const sortedContacts = [...contacts].sort((a, b) => {
        if (!a.lastInteractionAt) return -1;
        if (!b.lastInteractionAt) return 1;
        return new Date(a.lastInteractionAt) - new Date(b.lastInteractionAt);
      });

      // To prevent total predictability, we pick from the top 2 least active contacts randomly
      const candidates = sortedContacts.slice(0, Math.min(2, sortedContacts.length));
      targetContact = candidates[Math.floor(Math.random() * candidates.length)];
    }

    console.log(`Initiating active warmup message to: ${targetContact.name} (${targetContact.phone})`);
    await db.addLog('info', `Active Warmup: Selected ${targetContact.name} (${targetContact.phone}) for starting conversation.`);

    try {
      const message = await generateStarter(targetContact.name, config.currentDay, targetContact.notes);
      if (!message) {
        throw new Error('Gemini failed to generate starter message');
      }

      const sent = await sendMessage(targetContact.phone, message);
      if (sent) {
        await db.addLog('success', `Active starter successfully sent to ${targetContact.name}`);
        return true;
      } else {
        await db.addLog('error', `Active warmup failed to send message to ${targetContact.name} via Evolution API. Retrying next candidate...`);
        excludePhones.push(targetContact.phone);
        return await this.runActiveWarmupCycle(excludePhones);
      }
    } catch (error) {
      console.error('Active warmup cycle execution failed:', error);
      await db.addLog('error', `Active warmup failed to send message to ${targetContact.name}: ${error.message}. Retrying next candidate...`);
      excludePhones.push(targetContact.phone);
      return await this.runActiveWarmupCycle(excludePhones);
    }
  }

  /**
   * Queues an incoming message for response in the morning if night rest mode is on.
   */
  async queueNightMessage(phone, messageText, contactName, msgKey, remoteJid) {
    const settings = db.getSettings();
    const nightQueue = settings.nightQueue || [];
    
    // Check if contact already has a message queued
    const existingIdx = nightQueue.findIndex(q => q.phone === phone);
    if (existingIdx !== -1) {
      // Overwrite/update with latest message
      nightQueue[existingIdx].messageText = messageText;
      nightQueue[existingIdx].msgKey = msgKey;
      nightQueue[existingIdx].remoteJid = remoteJid;
      nightQueue[existingIdx].timestamp = new Date().toISOString();
    } else {
      nightQueue.push({
        phone,
        contactName,
        messageText,
        msgKey,
        remoteJid,
        timestamp: new Date().toISOString()
      });
    }

    await db.saveSettings({ nightQueue });
    await db.addLog('info', `Queued overnight message from ${contactName || phone} for morning reply.`, messageText, phone);
  }

  /**
   * Periodically checks the overnight queue and dispatches replies when day mode starts.
   */
  async processNightQueue() {
    const config = getConfig();
    if (config.nightRestEnabled && isNightTime()) return;

    const settings = db.getSettings();
    const nightQueue = settings.nightQueue || [];

    if (nightQueue.length === 0) return;

    // Shift first item from queue to process
    const item = nightQueue.shift();
    await db.saveSettings({ nightQueue });

    console.log(`Processing night queue message for ${item.contactName || item.phone}...`);
    await db.addLog('info', `Processing overnight queued reply for ${item.contactName || item.phone}...`, item.messageText, item.phone);

    // Process asynchronously to stagger and not block loop execution
    setTimeout(async () => {
      try {
        // 1. Go Online (available)
        await sendTypingState(item.phone, 'available', 1500);

        // 2. Mark Read (V כחול)
        if (item.remoteJid && item.msgKey) {
          await markRead(item.remoteJid, item.msgKey);
        }

        // Check quota and depth limits before proceeding with reply
        const todayStr = db.getTodayDateString();
        const stats = db.getStatsForDate(todayStr);
        const dailyQuota = getDailyQuota();
        if (stats.outgoing >= dailyQuota) {
          console.log(`Night queue reply skipped for ${item.phone}: Daily outgoing quota reached (${stats.outgoing}/${dailyQuota}).`);
          await db.addLog('warning', `Overnight reply skipped: Daily quota limit reached (${stats.outgoing}/${dailyQuota}).`);
          return;
        }

        const todayContactLogs = db.getLogs().filter(log =>
          log.phone === item.phone &&
          (log.type === 'message' || log.type === 'sent' || log.type === 'success') &&
          log.timestamp && log.timestamp.startsWith(todayStr)
        );
        const baseCap = config.maxRepliesPerContactPerDay || 4;
        const hashStr = item.phone + todayStr;
        let hash = 0;
        for (let i = 0; i < hashStr.length; i++) {
          hash = (hash << 5) - hash + hashStr.charCodeAt(i);
        }
        const variance = (Math.abs(hash) % 3) - 1;
        const dynamicMaxReplies = Math.max(2, baseCap + variance);

        if (todayContactLogs.length >= dynamicMaxReplies) {
          console.log(`Night queue reply skipped for ${item.phone}: Reached dynamic daily conversation depth (${dynamicMaxReplies}).`);
          await db.addLog('info', `Overnight reply skipped: Daily conversation depth reached (${todayContactLogs.length}/${dynamicMaxReplies}) for ${item.contactName || item.phone}.`);
          return;
        }

        // 3. Stagger delay (simulate reading: 1.5 seconds)
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 4. Load history and Generate Reply
        const logs = db.getLogs().filter(log => log.phone === item.phone);
        const conversationHistory = logs.slice(0, 10).reverse();
        
        const contact = db.getContacts().find(c => c.phone === item.phone);
        const contactNotes = contact ? contact.notes : '';

        const replyText = await generateReply(
          item.contactName,
          item.messageText,
          conversationHistory,
          settings.currentDay,
          contactNotes
        );

        // 5. Send reaction or message reply (support reactions too!)
        const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
        if (reactionMatch) {
          const emoji = reactionMatch[1].trim();
          if (item.remoteJid && item.msgKey) {
            const success = await sendReaction(item.remoteJid, emoji, item.msgKey);
            if (!success) {
              await sendMessage(item.phone, emoji, true);
            }
          } else {
            await sendMessage(item.phone, emoji, true);
          }
        } else {
          await sendMessage(item.phone, replyText, true);
        }

        // 6. Go Offline (unavailable)
        await sendTypingState(item.phone, 'unavailable', 500);
        await db.addLog('success', `Sent overnight queued response to ${item.contactName || item.phone}`);
      } catch (err) {
        console.error('Failed to process night queue item:', err);
        await db.addLog('error', `Failed to reply to overnight queued message for ${item.phone}: ${err.message}`);
      }
    }, 100);
  }

  /**
   * Queues a reply to be sent after a certain timestamp.
   */
  async queueDelayedReply(phone, remoteJid, messageText, contactName, msgKey, sendAfter) {
    const settings = db.getSettings();
    const delayedReplies = settings.delayedReplies || [];
    
    delayedReplies.push({
      phone,
      remoteJid,
      messageText,
      contactName,
      msgKey,
      sendAfter
    });
    
    await db.saveSettings({ delayedReplies });
  }

  /**
   * Checks the delayed replies queue and processes replies that are due.
   */
  async processDelayedReplies() {
    const config = getConfig();
    if (config.nightRestEnabled && isNightTime()) return;

    const settings = db.getSettings();
    const delayedReplies = settings.delayedReplies || [];
    if (delayedReplies.length === 0) return;

    const now = new Date();
    const toProcess = [];
    const remaining = [];

    for (const reply of delayedReplies) {
      if (!config.busySimulationEnabled || now >= new Date(reply.sendAfter)) {
        toProcess.push(reply);
      } else {
        remaining.push(reply);
      }
    }

    if (toProcess.length > 0) {
      await db.saveSettings({ delayedReplies: remaining });

      for (const reply of toProcess) {
        console.log(`Processing delayed reply for ${reply.contactName || reply.phone}...`);
        
        // Execute asynchronously in background
        setTimeout(async () => {
          try {
            await db.addLog('info', `Starting delayed reply sequence for ${reply.phone}`);

            // 1. Go Online (available)
            await sendTypingState(reply.phone, 'available', 1500);

            // 2. Mark Read (V כחול)
            await markRead(reply.remoteJid, reply.msgKey);

            // Check quota and depth limits before proceeding with reply
            const todayStr = db.getTodayDateString();
            const stats = db.getStatsForDate(todayStr);
            const dailyQuota = getDailyQuota();
            if (stats.outgoing >= dailyQuota) {
              console.log(`Delayed reply skipped for ${reply.phone}: Daily outgoing quota reached (${stats.outgoing}/${dailyQuota}).`);
              await db.addLog('warning', `Delayed reply skipped: Daily quota limit reached (${stats.outgoing}/${dailyQuota}).`);
              return;
            }

            const todayContactLogs = db.getLogs().filter(log =>
              log.phone === reply.phone &&
              (log.type === 'message' || log.type === 'sent' || log.type === 'success') &&
              log.timestamp && log.timestamp.startsWith(todayStr)
            );
            const baseCap = config.maxRepliesPerContactPerDay || 4;
            const hashStr = reply.phone + todayStr;
            let hash = 0;
            for (let i = 0; i < hashStr.length; i++) {
              hash = (hash << 5) - hash + hashStr.charCodeAt(i);
            }
            const variance = (Math.abs(hash) % 3) - 1;
            const dynamicMaxReplies = Math.max(2, baseCap + variance);

            if (todayContactLogs.length >= dynamicMaxReplies) {
              console.log(`Delayed reply skipped for ${reply.phone}: Reached dynamic daily conversation depth (${dynamicMaxReplies}).`);
              await db.addLog('info', `Delayed reply skipped: Daily conversation depth reached (${todayContactLogs.length}/${dynamicMaxReplies}) for ${reply.contactName || reply.phone}.`);
              return;
            }

            // 3. Stagger delay (simulate reading: 1.5 seconds)
            await new Promise(resolve => setTimeout(resolve, 1500));

            // 4. Generate Reply
            await db.addLog('info', `Calling Gemini for delayed reply to ${reply.phone}`);
            const logs = db.getLogs().filter(log => log.phone === reply.phone);
            const history = logs.slice(0, 10).reverse();
            
            const contact = db.getContacts().find(c => c.phone === reply.phone);
            const contactNotes = contact ? contact.notes : '';

            const replyText = await generateReply(reply.contactName, reply.messageText, history, config.currentDay, contactNotes);
            await db.addLog('info', `Gemini response generated for delayed reply to ${reply.phone}: "${replyText}"`);

            // 5. Send reaction or message reply
            const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
            if (reactionMatch) {
              const emoji = reactionMatch[1].trim();
              if (reply.msgKey?.id) {
                await db.addLog('info', `Sending emoji reaction "${emoji}" to ${reply.phone}`);
                const success = await sendReaction(reply.remoteJid, emoji, reply.msgKey);
                if (!success) {
                  await sendMessage(reply.phone, emoji, true);
                }
              }
            } else {
              await db.addLog('info', `Sending text reply to ${reply.phone}`);
              await sendMessage(reply.phone, replyText, true);
            }

            // 6. Go Offline (unavailable)
            await sendTypingState(reply.phone, 'unavailable', 500);
          } catch (err) {
            console.error(`Error in delayed reply sequence for ${reply.phone}:`, err);
            await db.addLog('error', `Delayed reply sequence failed: ${err.message}`);
          }
        }, 100);
      }
    }
  }

  /**
   * Automatically advances the current warmup day every 24 hours of runtime.
   */
  async checkDayProgression() {
    const settings = db.getSettings();
    const lastDayUpdate = settings.lastDayUpdateAt;
    
    const oneDayMs = 24 * 60 * 60 * 1000;
    const now = new Date();

    if (!lastDayUpdate) {
      await db.saveSettings({
        lastDayUpdateAt: now.toISOString()
      });
      return;
    }

    const diff = now - new Date(lastDayUpdate);
    if (diff >= oneDayMs) {
      const nextDay = Math.min(settings.currentDay + 1, 14);
      
      if (nextDay !== settings.currentDay) {
        await db.saveSettings({
          currentDay: nextDay,
          lastDayUpdateAt: now.toISOString()
        });
        await db.addLog('success', `System automatically advanced to Warmup Day ${nextDay}/14!`);
        console.log(`System advanced to Warmup Day ${nextDay}/14!`);
      } else {
        // Cap at Day 14, just update the timestamp
        await db.saveSettings({
          lastDayUpdateAt: now.toISOString()
        });
      }
    }
  }

  /**
   * Triggers a manual starter message immediately for debugging/testing.
   */
  async triggerManualStarter(phone) {
    const contacts = db.getContacts();
    const contact = contacts.find(c => c.phone === phone);
    if (!contact) {
      throw new Error(`Contact not found with phone: ${phone}`);
    }

    const settings = db.getSettings();
    const message = await generateStarter(contact.name, settings.currentDay);
    if (!message) {
      throw new Error('Gemini failed to generate starter message');
    }

    await db.addLog('info', `Manual Starter Triggered for ${contact.name}`);
    const sent = await sendMessage(contact.phone, message);
    if (!sent) {
      throw new Error(`Evolution API failed to send message to ${contact.phone}`);
    }
    return message;
  }

  /**
   * Evaluates if we should post a daily status story and executes it.
   */
  async checkAndPostDailyStatus() {
    const config = getConfig();
    if (!config.warmupEnabled) return;
    if (config.nightRestEnabled && isNightTime()) return;

    const today = db.getTodayDateString();
    const settings = db.getSettings();
    
    if (settings.lastStatusPostDate === today) {
      return; // Already posted today
    }

    const { hour } = getIsraelTime();
    if (hour < 9 || hour > 18) return; // Only post between 09:00 and 18:00 Israel local time

    const roll = Math.random();
    // 25% chance of posting this hour, or force it if it's late (after 17:00)
    if (roll > 0.25 && hour < 17) {
      console.log('Daily status check: rolled skip for this hour.');
      return;
    }

    return await this.triggerManualStatusPost();
  }

  /**
   * Triggers a manual status post immediately (picks random image or text).
   */
  async triggerManualStatusPost() {
    const today = db.getTodayDateString();
    console.log('Initiating WhatsApp status post...');
    await db.addLog('info', 'Initiating WhatsApp Status update post...');

    try {
      // Calculate the current time period to keep the status topics realistic
      const { hour } = getIsraelTime();
      let timePeriod = 'morning';
      if (hour >= 12 && hour < 17) timePeriod = 'afternoon';
      else if (hour >= 17 && hour < 21) timePeriod = 'evening';
      else if (hour >= 21 || hour < 6) timePeriod = 'night';

      let postedImage = false;
      const chooseImage = Math.random() > 0.5; // 50% chance of image status, 50% text status
      
      if (chooseImage) {
        try {
          // 1. Generate a random image prompt using Gemini with time period context
          const imagePrompt = await generateImagePrompt(timePeriod);
          console.log(`Generated status image prompt for ${timePeriod}: "${imagePrompt}"`);
          
          // 2. Fetch the image from Pollinations.ai with retry and browser User-Agent
          await db.addLog('info', `Generating status image via AI (${timePeriod}): "${imagePrompt}"`);
          let response = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const seed = Math.floor(Math.random() * 1000000);
              const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=600&height=1000&nologo=true&seed=${seed}&model=turbo`;
              response = await fetch(imageUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                },
                signal: AbortSignal.timeout(25000)
              });
              if (response.ok) break;
              console.warn(`Pollinations attempt ${attempt} returned status ${response.status}, retrying...`);
            } catch (e) {
              console.warn(`Pollinations attempt ${attempt} error: ${e.message}`);
            }
            if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
          }
          
          if (!response || !response.ok) {
            throw new Error(`Failed to generate image from Pollinations: status ${response?.status || 'network error'}`);
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64Data = `data:image/jpeg;base64,${buffer.toString('base64')}`;

          // Save the image locally so the dashboard UI can display it
          const localSavePath = path.join(__dirname, 'public', 'assets', 'status_images', 'last_status.jpg');
          try {
            await fs.mkdir(path.dirname(localSavePath), { recursive: true });
            await fs.writeFile(localSavePath, buffer);
          } catch (saveErr) {
            console.error('Failed to save last status image locally:', saveErr);
          }
          
          // 3. Generate caption in Hebrew based on the prompt topic
          const caption = await generateStatusCaption(imagePrompt);
          
          // 4. Send status
          const success = await sendStatus('image', base64Data, caption);
          if (success) {
            await db.saveSettings({ 
              lastStatusPostDate: today,
              lastStatusPostType: 'image',
              lastStatusPostCaption: caption,
              lastStatusPostFile: 'last_status.jpg',
              lastStatusPostText: ''
            });
            await db.addLog('success', `WhatsApp AI-generated status image posted: "${caption}"`);
            postedImage = true;
            return { type: 'image', caption, file: 'last_status.jpg' };
          }
        } catch (imgErr) {
          console.warn(`Status image generation/upload failed (${imgErr.message}), falling back to text status...`);
          await db.addLog('warning', `Image status failed (${imgErr.message}), falling back to text status.`);
        }
      }

      if (!postedImage) {
        // Generate text status with time period context
        const text = await generateStatusText(timePeriod);
        
        // Send status
        const success = await sendStatusText(text);
        if (success) {
          await db.saveSettings({ 
            lastStatusPostDate: today,
            lastStatusPostType: 'text',
            lastStatusPostCaption: '',
            lastStatusPostFile: '',
            lastStatusPostText: text
          });
          await db.addLog('success', `WhatsApp status text posted: "${text}"`);
          return { type: 'text', text };
        }
      }
    } catch (err) {
      console.error('Failed to post status story:', err);
      await db.addLog('error', `Failed to post status update: ${err.message}`);
      throw err;
    }
  }

  /**
   * Schedules the next spontaneous app check-in.
   */
  scheduleNextSpontaneousCheckIn(isFirst = false) {
    if (this.spontaneousCheckInTimeoutId) clearTimeout(this.spontaneousCheckInTimeoutId);

    const config = getConfig();
    if (!config.warmupEnabled) return;

    let delayMs;
    if (isFirst) {
      // First check-in after startup: 10 to 30 minutes
      const delayMinutes = Math.floor(Math.random() * 21) + 10;
      delayMs = delayMinutes * 60 * 1000;
      console.log(`Scheduling FIRST spontaneous check-in after startup in ${delayMinutes} minutes.`);
    } else {
      // Schedule next check-in in 20 to 60 minutes
      const delayMinutes = Math.floor(Math.random() * 41) + 20;
      delayMs = delayMinutes * 60 * 1000;
      console.log(`Scheduling next spontaneous check-in in ${delayMinutes} minutes.`);
    }

    this.spontaneousCheckInTimeoutId = setTimeout(() => {
      this.performSpontaneousCheckIn();
    }, delayMs);
  }

  /**
   * Performs a random app open simulation (goes online for a random short period).
   */
  async performSpontaneousCheckIn() {
    try {
      const config = getConfig();
      if (!config.warmupEnabled) {
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      if (config.nightRestEnabled && isNightTime()) {
        console.log('Spontaneous check-in skipped: Night rest mode active.');
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      const contacts = db.getContacts().filter(c => c.enabled);
      if (contacts.length === 0) {
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      // Pick a random enabled contact to target the presence state
      const contact = contacts[Math.floor(Math.random() * contacts.length)];
      
      // Random duration online: 15 to 50 seconds
      const durationSeconds = Math.floor(Math.random() * 36) + 15;
      const durationMs = durationSeconds * 1000;

      await db.addLog('info', `Simulating spontaneous app open: Going Online for ${durationSeconds} seconds.`);
      
      // Go Online (available)
      await sendTypingState(contact.phone, 'available', durationMs);
      
      // Go Offline (unavailable)
      await sendTypingState(contact.phone, 'unavailable', 500);

    } catch (err) {
      console.error('Error during spontaneous check-in:', err);
    } finally {
      this.scheduleNextSpontaneousCheckIn();
    }
  }

  /**
   * Shuts down all intervals and timers.
   */
  destroy() {
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.queueIntervalId) clearInterval(this.queueIntervalId);
    if (this.dayCheckIntervalId) clearInterval(this.dayCheckIntervalId);
    if (this.spontaneousCheckInTimeoutId) clearTimeout(this.spontaneousCheckInTimeoutId);
  }
}

const scheduler = new WarmupScheduler();
export default scheduler;
