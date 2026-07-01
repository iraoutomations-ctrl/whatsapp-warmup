import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';
import { getConfig, isNightTime, isWeekend, getDailyQuota, getIsraelTime } from './config.js';
import { generateStarter, generateReply, generateStatusText, generateStatusCaption } from './gemini.js';
import { sendMessage, sendStatusText, sendStatusImage } from './evolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class WarmupScheduler {
  constructor() {
    this.activeTimeoutId = null;
    this.queueIntervalId = null;
    this.dayCheckIntervalId = null;
  }

  async init() {
    console.log('Initializing Warmup Scheduler...');
    
    // Start the active warmup scheduling loop
    await this.scheduleNextWarmup();

    // Start background processing interval for night queue (check every 60 seconds)
    this.queueIntervalId = setInterval(() => this.processNightQueue(), 60 * 1000);

    // Start day progression tracker and daily status poster (check every hour)
    this.dayCheckIntervalId = setInterval(() => {
      this.checkDayProgression();
      this.checkAndPostDailyStatus();
    }, 60 * 60 * 1000);

    // Run a quick status check 10 seconds after startup
    setTimeout(() => this.checkAndPostDailyStatus(), 10 * 1000);

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

    const nextRunTime = new Date(Date.now() + delayMs);
    console.log(`Next active warmup starter scheduled for: ${nextRunTime.toLocaleTimeString()}`);

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
  async runActiveWarmupCycle() {
    const config = getConfig();

    if (!config.warmupEnabled) {
      console.log('Active warmup cycle skipped: Warmup is currently disabled.');
      return;
    }

    if (isNightTime()) {
      console.log('Active warmup cycle skipped: Night rest mode is active.');
      await db.addLog('info', 'Active warmup skipped: Night rest hours.');
      return;
    }

    // Check daily message quota
    const today = db.getTodayDateString();
    const stats = db.getStatsForDate(today);
    const dailyQuota = getDailyQuota();

    if (stats.outgoing >= dailyQuota) {
      console.log(`Active warmup cycle skipped: Daily outgoing message quota reached (${stats.outgoing}/${dailyQuota}).`);
      await db.addLog('warning', `Active warmup skipped: Daily quota limit reached (${stats.outgoing}/${dailyQuota}).`);
      return;
    }

    // Pick a contact
    const contacts = db.getContacts().filter(c => c.enabled);
    if (contacts.length === 0) {
      console.log('Active warmup cycle skipped: No enabled guided contacts in the list.');
      await db.addLog('warning', 'Active warmup skipped: No enabled contacts found.');
      return;
    }

    // Pick contact with the least recent interaction, or random
    const sortedContacts = [...contacts].sort((a, b) => {
      if (!a.lastInteractionAt) return -1;
      if (!b.lastInteractionAt) return 1;
      return new Date(a.lastInteractionAt) - new Date(b.lastInteractionAt);
    });

    // To prevent total predictability, we pick from the top 2 least active contacts randomly
    const candidates = sortedContacts.slice(0, Math.min(2, sortedContacts.length));
    const targetContact = candidates[Math.floor(Math.random() * candidates.length)];

    console.log(`Initiating active warmup message to: ${targetContact.name} (${targetContact.phone})`);
    await db.addLog('info', `Active Warmup: Selected ${targetContact.name} (${targetContact.phone}) for starting conversation.`);

    try {
      const message = await generateStarter(targetContact.name, config.currentDay);
      if (!message) {
        throw new Error('Gemini failed to generate starter message');
      }

      await sendMessage(targetContact.phone, message);
      await db.addLog('success', `Active starter successfully sent to ${targetContact.name}`);
    } catch (error) {
      console.error('Active warmup cycle execution failed:', error);
      await db.addLog('error', `Active warmup failed to send message: ${error.message}`);
    }
  }

  /**
   * Queues an incoming message for response in the morning if night rest mode is on.
   */
  async queueNightMessage(phone, messageText, contactName) {
    const settings = db.getSettings();
    const nightQueue = settings.nightQueue || [];
    
    // Check if contact already has a message queued
    const existingIdx = nightQueue.findIndex(q => q.phone === phone);
    if (existingIdx !== -1) {
      // Overwrite/update with latest message
      nightQueue[existingIdx].messageText = messageText;
      nightQueue[existingIdx].timestamp = new Date().toISOString();
    } else {
      nightQueue.push({
        phone,
        contactName,
        messageText,
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
    if (isNightTime()) return;

    const settings = db.getSettings();
    const nightQueue = settings.nightQueue || [];

    if (nightQueue.length === 0) return;

    // Shift first item from queue to process
    const item = nightQueue.shift();
    await db.saveSettings({ nightQueue });

    console.log(`Processing night queue message for ${item.contactName || item.phone}...`);
    await db.addLog('info', `Processing overnight queued reply for ${item.contactName || item.phone}...`, item.messageText, item.phone);

    try {
      // Load history
      const logs = db.getLogs().filter(log => log.phone === item.phone);
      const conversationHistory = logs.slice(0, 10).reverse();

      const replyText = await generateReply(
        item.contactName,
        item.messageText,
        conversationHistory,
        settings.currentDay
      );

      // Stagger sending slightly to simulate realistic morning check-in behavior
      const typingDelay = Math.floor(Math.random() * 5000) + 3000; // 3-8 seconds
      
      // We will send it
      await sendMessage(item.phone, replyText, true);
      await db.addLog('success', `Sent overnight queued response to ${item.contactName || item.phone}`);
    } catch (err) {
      console.error('Failed to process night queue item:', err);
      await db.addLog('error', `Failed to reply to overnight queued message for ${item.phone}: ${err.message}`);
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
    await sendMessage(contact.phone, message);
    return message;
  }

  /**
   * Evaluates if we should post a daily status story and executes it.
   */
  async checkAndPostDailyStatus() {
    const config = getConfig();
    if (!config.warmupEnabled) return;
    if (isNightTime()) return;

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
      const chooseImage = Math.random() > 0.8; // 20% chance of image status, 80% text status
      
      if (chooseImage) {
        // Pick random image from local folder
        const images = [
          { file: 'coffee_morning.png', topic: 'morning coffee cup on a wooden desk' },
          { file: 'office_cat.png', topic: 'cute office cat sleeping next to a coding laptop' },
          { file: 'robot_working.png', topic: 'friendly little robot cartoon working at a computer' },
          { file: 'tel_aviv_sunrise.png', topic: 'tel aviv skyline viewed through an office window at sunrise' },
          { file: 'shield_success.png', topic: 'laptop screen showing a bright green reputation shield' }
        ];
        
        const selected = images[Math.floor(Math.random() * images.length)];
        const imagePath = path.join(__dirname, 'public', 'assets', 'status_images', selected.file);
        
        // Generate caption
        const caption = await generateStatusCaption(selected.topic);
        
        // Send status
        const success = await sendStatusImage(imagePath, caption);
        if (success) {
          await db.saveSettings({ 
            lastStatusPostDate: today,
            lastStatusPostType: 'image',
            lastStatusPostCaption: caption,
            lastStatusPostFile: selected.file,
            lastStatusPostText: ''
          });
          await db.addLog('success', `WhatsApp status image posted: "${caption}" (Asset: ${selected.file})`);
          return { type: 'image', caption, file: selected.file };
        }
      } else {
        // Generate text status
        const text = await generateStatusText();
        
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
   * Shuts down all intervals and timers.
   */
  destroy() {
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.queueIntervalId) clearInterval(this.queueIntervalId);
    if (this.dayCheckIntervalId) clearInterval(this.dayCheckIntervalId);
  }
}

const scheduler = new WarmupScheduler();
export default scheduler;
