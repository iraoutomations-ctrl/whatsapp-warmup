import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import db from './database.js';
import { getConfig, getGlobalConfig, isNightTime, isWeekend, getDailyQuota, getIsraelTime, computeDynamicContactCap } from './config.js';
import { generateStarter, generateReply, generateStatusText, generateStatusCaption, generateImagePrompt } from './gemini.js';
import { sendMessage, sendStatusText, sendStatusImage, sendStatus, markRead, sendReaction, sendTypingState, handleLimitStop } from './evolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One WarmupScheduler worker runs per bot instance (WhatsApp number) - each
// has its own independent day/quota/night-rest/queue state, since that
// state exists specifically to protect that one number's reputation.
// Leaderboard sweep is NOT here - it's tenant-agnostic (one shared
// chats.json across every instance) and runs once globally, owned by
// SchedulerManager below.
class WarmupScheduler {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.activeTimeoutId = null;
    this.queueIntervalId = null;
    this.dayCheckIntervalId = null;
    this.spontaneousCheckInTimeoutId = null;
    this.initialStatusCheckTimeoutId = null;
  }

  async init() {
    console.log(`Initializing Warmup Scheduler for instance ${this.instanceId}...`);

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

    // Run a quick status check 10 seconds after startup. Tracked (not a
    // bare setTimeout) so destroy() can cancel it - otherwise an instance
    // deleted within its first 10 seconds leaves this orphaned, and it
    // fires afterward against an instanceId that no longer resolves,
    // crashing the process (getConfig throws loudly by design).
    this.initialStatusCheckTimeoutId = setTimeout(() => this.checkAndPostDailyStatus(), 10 * 1000);

    // Start random spontaneous check-ins (opening WhatsApp without messaging)
    this.scheduleNextSpontaneousCheckIn(true); // First run is 15 seconds for testing

    await db.addLog('info', 'Warmup Scheduler initialized and active loop scheduled.', '', '', false, this.instanceId);
  }

  /**
   * Schedules the next active warmup starter at a random interval.
   */
  async scheduleNextWarmup(forcedDelayMs = null) {
    // Clear any existing timeout
    if (this.activeTimeoutId) {
      clearTimeout(this.activeTimeoutId);
    }

    // Called unconditionally from the active-cycle timeout's finally block
    // below, even when runActiveWarmupCycle just no-opped because this
    // instance was deleted mid-flight - stop the self-rescheduling chain
    // here instead of throwing on the now-unresolvable id.
    if (!db.getInstanceById(this.instanceId)) return;

    const config = getConfig(this.instanceId);
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
    if (config.nightRestEnabled && isNightTime(this.instanceId, nextRunTime)) {
      let guard = 0;
      while (isNightTime(this.instanceId, nextRunTime) && guard < 100) {
        nextRunTime = new Date(nextRunTime.getTime() + 15 * 60 * 1000);
        guard++;
      }
      // Add a random 5 to 25 minutes offset into the morning
      const morningOffset = (Math.floor(Math.random() * 21) + 5) * 60 * 1000;
      nextRunTime = new Date(nextRunTime.getTime() + morningOffset);
      delayMs = Math.max(1000, nextRunTime.getTime() - Date.now());
    }

    console.log(`[${this.instanceId}] Next active warmup starter scheduled for: ${nextRunTime.toLocaleTimeString()}`);

    // Pre-calculate target contact for dashboard display
    const contacts = db.getContacts().filter(c => c.instanceId === this.instanceId && c.enabled);
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

    // Save planned schedule and target details to this instance's record
    await db.updateInstance(this.instanceId, {
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
    // Guards against a deleted instance's still-scheduled setTimeout chain
    // firing after destroy() should have stopped it (the timer itself is
    // tracked and cancelled, but a call already in flight at deletion time
    // isn't) - bail out quietly instead of crashing on a now-unresolvable id.
    if (!db.getInstanceById(this.instanceId)) return false;
    const config = getConfig(this.instanceId);

    if (!config.warmupEnabled) {
      console.log(`[${this.instanceId}] Active warmup cycle skipped: Warmup is currently disabled.`);
      return false;
    }

    if (config.nightRestEnabled && isNightTime(this.instanceId)) {
      console.log(`[${this.instanceId}] Active warmup loop: Night rest mode active. Skipping active message.`);
      return false;
    }

    // Check daily message quota
    const today = db.getTodayDateString();
    const stats = db.getStatsForInstanceDate(this.instanceId, today);
    const dailyQuota = getDailyQuota(this.instanceId);

    if (stats.outgoing >= dailyQuota) {
      console.log(`[${this.instanceId}] Active warmup cycle skipped: Daily outgoing message quota reached (${stats.outgoing}/${dailyQuota}).`);
      await db.addLog('warning', `Active warmup skipped: Daily quota limit reached (${stats.outgoing}/${dailyQuota}).`, '', '', false, this.instanceId);
      return false;
    }

    // Pick a contact (prefer the pre-scheduled target contact if not excluded)
    const contacts = db.getContacts().filter(c => c.instanceId === this.instanceId && c.enabled && !excludePhones.includes(c.phone));
    if (contacts.length === 0) {
      console.log(`[${this.instanceId}] Active warmup cycle aborted: No available candidate contacts left.`);
      if (excludePhones.length > 0) {
        await db.addLog('warning', 'Active warmup cycle aborted: All candidate contacts failed sending.', '', '', false, this.instanceId);
      } else {
        await db.addLog('warning', 'Active warmup skipped: No enabled contacts found.', '', '', false, this.instanceId);
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

    console.log(`[${this.instanceId}] Initiating active warmup message to: ${targetContact.name} (${targetContact.phone})`);
    await db.addLog('info', `Active Warmup: Selected ${targetContact.name} (${targetContact.phone}) for starting conversation.`, '', '', false, this.instanceId);

    try {
      const message = await generateStarter(targetContact.name, config.currentDay, targetContact.notes);
      if (!message) {
        throw new Error('Gemini failed to generate starter message');
      }

      const sent = await sendMessage(config, targetContact.phone, message);
      if (sent) {
        await db.addLog('success', `Active starter successfully sent to ${targetContact.name}`, '', '', false, this.instanceId);
        return true;
      } else {
        await db.addLog('error', `Active warmup failed to send message to ${targetContact.name} via Evolution API. Retrying next candidate...`, '', '', false, this.instanceId);
        excludePhones.push(targetContact.phone);
        return await this.runActiveWarmupCycle(excludePhones);
      }
    } catch (error) {
      console.error('Active warmup cycle execution failed:', error);
      await db.addLog('error', `Active warmup failed to send message to ${targetContact.name}: ${error.message}. Retrying next candidate...`, '', '', false, this.instanceId);
      excludePhones.push(targetContact.phone);
      return await this.runActiveWarmupCycle(excludePhones);
    }
  }

  /**
   * Queues an incoming message for response in the morning if night rest mode is on.
   */
  async queueNightMessage(phone, messageText, contactName, msgKey, remoteJid) {
    const config = getConfig(this.instanceId);
    const nightQueue = config.nightQueue || [];

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

    await db.updateInstance(this.instanceId, { nightQueue });
    await db.addLog('info', `Queued overnight message from ${contactName || phone} for morning reply.`, messageText, phone, false, this.instanceId);
  }

  /**
   * Periodically checks the overnight queue and dispatches replies when day mode starts.
   */
  async processNightQueue() {
    const config = getConfig(this.instanceId);
    if (config.nightRestEnabled && isNightTime(this.instanceId)) return;

    const nightQueue = config.nightQueue || [];
    if (nightQueue.length === 0) return;

    // Shift first item from queue to process
    const item = nightQueue.shift();
    await db.updateInstance(this.instanceId, { nightQueue });

    console.log(`[${this.instanceId}] Processing night queue message for ${item.contactName || item.phone}...`);
    await db.addLog('info', `Processing overnight queued reply for ${item.contactName || item.phone}...`, item.messageText, item.phone, false, this.instanceId);

    // Process asynchronously to stagger and not block loop execution
    setTimeout(async () => {
      try {
        // Check quota and depth limits before marking read or replying
        const todayStr = db.getTodayDateString();
        const stats = db.getStatsForInstanceDate(this.instanceId, todayStr);
        const dailyQuota = getDailyQuota(this.instanceId);
        const emergencyQuota = Math.floor(dailyQuota * 1.5);
        if (stats.outgoing >= emergencyQuota) {
          await handleLimitStop(config, item.phone, item.remoteJid, item.msgKey, item.contactName, `Emergency quota reached (${stats.outgoing}/${emergencyQuota})`);
          return;
        }

        const contactCap = computeDynamicContactCap(item.phone, this.instanceId);
        if (contactCap.reached) {
          await handleLimitStop(config, item.phone, item.remoteJid, item.msgKey, item.contactName, `Conversation depth reached (${contactCap.count}/${contactCap.cap})`);
          return;
        }

        // 1. Go Online (available)
        await sendTypingState(config, item.phone, 'available', 1500);

        // 2. Mark Read (V כחול)
        if (item.remoteJid && item.msgKey) {
          await markRead(config, item.remoteJid, item.msgKey);
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
          config.currentDay,
          contactNotes
        );

        // 5. Send reaction or message reply (support reactions too!)
        const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
        if (reactionMatch) {
          const emoji = reactionMatch[1].trim();
          if (item.remoteJid && item.msgKey) {
            const success = await sendReaction(config, item.remoteJid, emoji, item.msgKey);
            if (!success) {
              await sendMessage(config, item.phone, emoji, true);
            }
          } else {
            await sendMessage(config, item.phone, emoji, true);
          }
        } else {
          await sendMessage(config, item.phone, replyText, true);
        }

        // 6. Go Offline (unavailable)
        await sendTypingState(config, item.phone, 'unavailable', 500);
        await db.addLog('success', `Sent overnight queued response to ${item.contactName || item.phone}`, '', '', false, this.instanceId);
      } catch (err) {
        console.error('Failed to process night queue item:', err);
        await db.addLog('error', `Failed to reply to overnight queued message for ${item.phone}: ${err.message}`, '', '', false, this.instanceId);
      }
    }, 100);
  }

  /**
   * Queues a reply to be sent after a certain timestamp.
   */
  async queueDelayedReply(phone, remoteJid, messageText, contactName, msgKey, sendAfter) {
    const config = getConfig(this.instanceId);
    const delayedReplies = config.delayedReplies || [];

    delayedReplies.push({
      phone,
      remoteJid,
      messageText,
      contactName,
      msgKey,
      sendAfter
    });

    await db.updateInstance(this.instanceId, { delayedReplies });
  }

  /**
   * Checks the delayed replies queue and processes replies that are due.
   */
  async processDelayedReplies() {
    const config = getConfig(this.instanceId);
    if (config.nightRestEnabled && isNightTime(this.instanceId)) return;

    const delayedReplies = config.delayedReplies || [];
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
      await db.updateInstance(this.instanceId, { delayedReplies: remaining });

      for (const reply of toProcess) {
        console.log(`[${this.instanceId}] Processing delayed reply for ${reply.contactName || reply.phone}...`);

        // Execute asynchronously in background
        setTimeout(async () => {
          try {
            await db.addLog('info', `Starting delayed reply sequence for ${reply.phone}`, '', '', false, this.instanceId);

            // Check quota and depth limits before marking read or replying
            const todayStr = db.getTodayDateString();
            const stats = db.getStatsForInstanceDate(this.instanceId, todayStr);
            const dailyQuota = getDailyQuota(this.instanceId);
            const emergencyQuota = Math.floor(dailyQuota * 1.5);
            if (stats.outgoing >= emergencyQuota) {
              await handleLimitStop(config, reply.phone, reply.remoteJid, reply.msgKey, reply.contactName, `Emergency quota reached (${stats.outgoing}/${emergencyQuota})`);
              return;
            }

            const contactCap = computeDynamicContactCap(reply.phone, this.instanceId);
            if (contactCap.reached) {
              await handleLimitStop(config, reply.phone, reply.remoteJid, reply.msgKey, reply.contactName, `Conversation depth reached (${contactCap.count}/${contactCap.cap})`);
              return;
            }

            // 1. Go Online (available)
            await sendTypingState(config, reply.phone, 'available', 1500);

            // 2. Mark Read (V כחול)
            await markRead(config, reply.remoteJid, reply.msgKey);

            // 3. Stagger delay (simulate reading: 1.5 seconds)
            await new Promise(resolve => setTimeout(resolve, 1500));

            // 4. Generate Reply
            await db.addLog('info', `Calling Gemini for delayed reply to ${reply.phone}`, '', '', false, this.instanceId);
            const logs = db.getLogs().filter(log => log.phone === reply.phone);
            const history = logs.slice(0, 10).reverse();

            const contact = db.getContacts().find(c => c.phone === reply.phone);
            const contactNotes = contact ? contact.notes : '';

            const replyText = await generateReply(reply.contactName, reply.messageText, history, config.currentDay, contactNotes);
            await db.addLog('info', `Gemini response generated for delayed reply to ${reply.phone}: "${replyText}"`, '', '', false, this.instanceId);

            // 5. Send reaction or message reply
            const reactionMatch = replyText.match(/^\[REACTION:\s*(.+)\]$/);
            if (reactionMatch) {
              const emoji = reactionMatch[1].trim();
              if (reply.msgKey?.id) {
                await db.addLog('info', `Sending emoji reaction "${emoji}" to ${reply.phone}`, '', '', false, this.instanceId);
                const success = await sendReaction(config, reply.remoteJid, emoji, reply.msgKey);
                if (!success) {
                  await sendMessage(config, reply.phone, emoji, true);
                }
              }
            } else {
              await db.addLog('info', `Sending text reply to ${reply.phone}`, '', '', false, this.instanceId);
              await sendMessage(config, reply.phone, replyText, true);
            }

            // 6. Go Offline (unavailable)
            await sendTypingState(config, reply.phone, 'unavailable', 500);
          } catch (err) {
            console.error(`Error in delayed reply sequence for ${reply.phone}:`, err);
            await db.addLog('error', `Delayed reply sequence failed: ${err.message}`, '', '', false, this.instanceId);
          }
        }, 100);
      }
    }
  }

  async checkDayProgression() {
    const instance = db.getInstanceById(this.instanceId);
    if (!instance) return;
    const lastDayUpdate = instance.lastDayUpdateAt;

    const oneDayMs = 24 * 60 * 60 * 1000;
    const now = new Date();

    if (!lastDayUpdate) {
      await db.updateInstance(this.instanceId, { lastDayUpdateAt: now.toISOString() });
      return;
    }

    const diff = now - new Date(lastDayUpdate);
    if (diff >= oneDayMs) {
      const nextDay = Math.min(instance.currentDay + 1, 14);

      if (nextDay !== instance.currentDay) {
        await db.updateInstance(this.instanceId, {
          currentDay: nextDay,
          lastDayUpdateAt: now.toISOString()
        });
        await db.addLog('success', `System automatically advanced to Warmup Day ${nextDay}/14!`, '', '', false, this.instanceId);
        console.log(`[${this.instanceId}] System advanced to Warmup Day ${nextDay}/14!`);
      } else {
        // Cap at Day 14, just update the timestamp
        await db.updateInstance(this.instanceId, { lastDayUpdateAt: now.toISOString() });
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

    const config = getConfig(this.instanceId);
    const message = await generateStarter(contact.name, config.currentDay);
    if (!message) {
      throw new Error('Gemini failed to generate starter message');
    }

    await db.addLog('info', `Manual Starter Triggered for ${contact.name}`, '', '', false, this.instanceId);
    const sent = await sendMessage(config, contact.phone, message);
    if (!sent) {
      throw new Error(`Evolution API failed to send message to ${contact.phone}`);
    }
    return message;
  }

  /**
   * Evaluates if we should post a daily status story and executes it.
   */
  async checkAndPostDailyStatus() {
    if (!db.getInstanceById(this.instanceId)) return;
    const config = getConfig(this.instanceId);
    if (!config.warmupEnabled) return;
    if (config.nightRestEnabled && isNightTime(this.instanceId)) return;

    const today = db.getTodayDateString();

    if (config.lastStatusPostDate === today) {
      return; // Already posted today
    }

    const { hour } = getIsraelTime();
    if (hour < 9 || hour > 18) return; // Only post between 09:00 and 18:00 Israel local time

    const roll = Math.random();
    // 25% chance of posting this hour, or force it if it's late (after 17:00)
    if (roll > 0.25 && hour < 17) {
      console.log(`[${this.instanceId}] Daily status check: rolled skip for this hour.`);
      return;
    }

    return await this.triggerManualStatusPost();
  }

  /**
   * Triggers a manual status post immediately (picks random image or text).
   */
  async triggerManualStatusPost() {
    const config = getConfig(this.instanceId);
    const today = db.getTodayDateString();
    console.log(`[${this.instanceId}] Initiating WhatsApp status post...`);
    await db.addLog('info', 'Initiating WhatsApp Status update post...', '', '', false, this.instanceId);

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
          await db.addLog('info', `Generating status image via AI (${timePeriod}): "${imagePrompt}"`, '', '', false, this.instanceId);
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
          const localSavePath = path.join(__dirname, 'public', 'assets', 'status_images', `${this.instanceId}_last_status.jpg`);
          try {
            await fs.mkdir(path.dirname(localSavePath), { recursive: true });
            await fs.writeFile(localSavePath, buffer);
          } catch (saveErr) {
            console.error('Failed to save last status image locally:', saveErr);
          }

          // 3. Generate caption in Hebrew based on the prompt topic
          const caption = await generateStatusCaption(imagePrompt);

          // 4. Send status
          const success = await sendStatus(config, 'image', base64Data, caption);
          if (success) {
            await db.updateInstance(this.instanceId, {
              lastStatusPostDate: today,
              lastStatusPostType: 'image',
              lastStatusPostCaption: caption,
              lastStatusPostFile: `${this.instanceId}_last_status.jpg`,
              lastStatusPostText: ''
            });
            await db.addLog('success', `WhatsApp AI-generated status image posted: "${caption}"`, '', '', false, this.instanceId);
            postedImage = true;
            return { type: 'image', caption, file: `${this.instanceId}_last_status.jpg` };
          }
        } catch (imgErr) {
          console.warn(`Status image generation/upload failed (${imgErr.message}), falling back to text status...`);
          await db.addLog('warning', `Image status failed (${imgErr.message}), falling back to text status.`, '', '', false, this.instanceId);
        }
      }

      if (!postedImage) {
        // Generate text status with time period context
        const text = await generateStatusText(timePeriod);

        // Send status
        const success = await sendStatusText(config, text);
        if (success) {
          await db.updateInstance(this.instanceId, {
            lastStatusPostDate: today,
            lastStatusPostType: 'text',
            lastStatusPostCaption: '',
            lastStatusPostFile: '',
            lastStatusPostText: text
          });
          await db.addLog('success', `WhatsApp status text posted: "${text}"`, '', '', false, this.instanceId);
          return { type: 'text', text };
        }
      }
    } catch (err) {
      console.error('Failed to post status story:', err);
      await db.addLog('error', `Failed to post status update: ${err.message}`, '', '', false, this.instanceId);
      throw err;
    }
  }

  /**
   * Schedules the next spontaneous app check-in.
   */
  scheduleNextSpontaneousCheckIn(isFirst = false) {
    if (this.spontaneousCheckInTimeoutId) clearTimeout(this.spontaneousCheckInTimeoutId);

    const config = getConfig(this.instanceId);
    if (!config.warmupEnabled) return;

    let delayMs;
    if (isFirst) {
      // First check-in after startup: 10 to 30 minutes
      const delayMinutes = Math.floor(Math.random() * 21) + 10;
      delayMs = delayMinutes * 60 * 1000;
      console.log(`[${this.instanceId}] Scheduling FIRST spontaneous check-in after startup in ${delayMinutes} minutes.`);
    } else {
      // Schedule next check-in in 20 to 60 minutes
      const delayMinutes = Math.floor(Math.random() * 41) + 20;
      delayMs = delayMinutes * 60 * 1000;
      console.log(`[${this.instanceId}] Scheduling next spontaneous check-in in ${delayMinutes} minutes.`);
    }

    this.spontaneousCheckInTimeoutId = setTimeout(() => {
      this.performSpontaneousCheckIn();
    }, delayMs);
  }

  /**
   * Performs a random app open simulation (goes online for a random short period).
   */
  async performSpontaneousCheckIn() {
    // Stop rescheduling entirely (don't fall through to the finally block's
    // reschedule) if this instance was deleted - otherwise it would keep
    // perpetually rescheduling itself against a now-nonexistent instance.
    if (!db.getInstanceById(this.instanceId)) return;
    try {
      const config = getConfig(this.instanceId);
      if (!config.warmupEnabled) {
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      if (config.nightRestEnabled && isNightTime(this.instanceId)) {
        console.log(`[${this.instanceId}] Spontaneous check-in skipped: Night rest mode active.`);
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      const contacts = db.getContacts().filter(c => c.instanceId === this.instanceId && c.enabled);
      if (contacts.length === 0) {
        this.scheduleNextSpontaneousCheckIn();
        return;
      }

      // Pick a random enabled contact to target the presence state
      const contact = contacts[Math.floor(Math.random() * contacts.length)];

      // Random duration online: 15 to 50 seconds
      const durationSeconds = Math.floor(Math.random() * 36) + 15;
      const durationMs = durationSeconds * 1000;

      await db.addLog('info', `Simulating spontaneous app open: Going Online for ${durationSeconds} seconds.`, '', '', false, this.instanceId);

      // Go Online (available)
      await sendTypingState(config, contact.phone, 'available', durationMs);

      // Go Offline (unavailable)
      await sendTypingState(config, contact.phone, 'unavailable', 500);

    } catch (err) {
      console.error('Error during spontaneous check-in:', err);
    } finally {
      this.scheduleNextSpontaneousCheckIn();
    }
  }

  /**
   * Shuts down all intervals and timers for this instance's worker.
   */
  destroy() {
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.queueIntervalId) clearInterval(this.queueIntervalId);
    if (this.dayCheckIntervalId) clearInterval(this.dayCheckIntervalId);
    if (this.spontaneousCheckInTimeoutId) clearTimeout(this.spontaneousCheckInTimeoutId);
    if (this.initialStatusCheckTimeoutId) clearTimeout(this.initialStatusCheckTimeoutId);
  }
}

// Owns one WarmupScheduler worker per bot instance, plus the single global
// leaderboard-retention sweep (tenant-agnostic - one shared chats.json).
// Admin instance CRUD (Phase 3) calls startWorkerForInstance/
// stopWorkerForInstance so adding/pausing a number takes effect live,
// without a server restart.
class SchedulerManager {
  constructor() {
    this.workers = new Map(); // instanceId -> WarmupScheduler
    this.leaderboardSweepIntervalId = null;
  }

  async init() {
    for (const inst of db.getInstances()) {
      await this.startWorkerForInstance(inst.id);
    }

    this.leaderboardSweepIntervalId = setInterval(() => this.sweepLeaderboard(), 60 * 60 * 1000);
    setTimeout(() => this.sweepLeaderboard(), 15 * 1000);
  }

  async startWorkerForInstance(instanceId) {
    if (this.workers.has(instanceId)) return this.workers.get(instanceId);
    const worker = new WarmupScheduler(instanceId);
    this.workers.set(instanceId, worker);
    await worker.init();
    return worker;
  }

  stopWorkerForInstance(instanceId) {
    const worker = this.workers.get(instanceId);
    if (worker) {
      worker.destroy();
      this.workers.delete(instanceId);
    }
  }

  getWorker(instanceId) {
    return this.workers.get(instanceId) || null;
  }

  /**
   * Soft-archives published leaderboard chats past their retention window
   * that didn't earn enough votes (and aren't in the current top-N). Runs
   * once globally, not per-instance - chats.json is shared across the whole
   * unified public leaderboard. Never deletes rows from chats.json - see
   * database.js sweepExpiredChats.
   */
  async sweepLeaderboard() {
    try {
      const config = getGlobalConfig();
      const archivedIds = await db.sweepExpiredChats({
        retentionDays: config.leaderboardRetentionDays,
        minVotesToKeep: config.leaderboardMinVotesToKeep,
        topNAlwaysKept: config.leaderboardTopNAlwaysKept
      });
      if (archivedIds.length > 0) {
        await db.addLog('info', `Leaderboard sweep archived ${archivedIds.length} chat(s) past retention.`);
      }
    } catch (err) {
      console.error('Leaderboard sweep failed:', err);
    }
  }

  destroy() {
    for (const worker of this.workers.values()) worker.destroy();
    this.workers.clear();
    if (this.leaderboardSweepIntervalId) clearInterval(this.leaderboardSweepIntervalId);
  }
}

const schedulerManager = new SchedulerManager();
export default schedulerManager;
