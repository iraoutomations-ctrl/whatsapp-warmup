import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

class JSONDatabase {
  constructor() {
    this.settings = {};
    this.contacts = [];
    this.logs = [];
    this.stats = {};
    this.isInitialized = false;
    this.writeQueue = {}; // Map to queue concurrent writes for each file type
  }

  async init() {
    if (this.isInitialized) return;

    try {
      // Ensure data directory exists
      await fs.mkdir(DATA_DIR, { recursive: true });

      // Initialize Settings
      this.settings = await this._loadOrInitFile('settings.json', {
        warmupEnabled: false,
        currentDay: 1,
        evolutionUrl: process.env.EVOLUTION_API_URL || '',
        evolutionToken: process.env.EVOLUTION_API_TOKEN || '',
        evolutionInstance: process.env.EVOLUTION_API_INSTANCE || '',
        geminiApiKey: process.env.GEMINI_API_KEY || '',
        nightRestStart: '23:00',
        nightRestEnd: '08:00',
        activeMinIntervalMinutes: 30,
        activeMaxIntervalMinutes: 90,
        week1Limit: 20,
        week2Limit: 60,
        groupsEnabled: true,
        groupReplyLimitPerDay: 2
      });

      // Initialize Contacts
      this.contacts = await this._loadOrInitFile('contacts.json', []);

      // Initialize Logs
      this.logs = await this._loadOrInitFile('logs.json', []);

      // Initialize Stats
      this.stats = await this._loadOrInitFile('stats.json', {});

      this.isInitialized = true;
      console.log('JSON Database successfully initialized.');
    } catch (error) {
      console.error('Failed to initialize JSON Database:', error);
      throw error;
    }
  }

  // Load a file or initialize it with default data if it doesn't exist
  async _loadOrInitFile(filename, defaultData) {
    const filePath = path.join(DATA_DIR, filename);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this._saveFile(filename, defaultData);
        return defaultData;
      }
      console.error(`Error reading ${filename}, resetting to defaults:`, error);
      return defaultData;
    }
  }

  // Thread-safe file writing queue
  async _saveFile(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp`;

    // Initialize queue for this filename if it doesn't exist
    if (!this.writeQueue[filename]) {
      this.writeQueue[filename] = Promise.resolve();
    }

    // Queue the write operation
    this.writeQueue[filename] = this.writeQueue[filename].then(async () => {
      try {
        const jsonString = JSON.stringify(data, null, 2);
        await fs.writeFile(tempPath, jsonString, 'utf-8');
        await fs.rename(tempPath, filePath);
      } catch (err) {
        console.error(`Error writing file ${filename}:`, err);
        // Try to clean up temp file
        try { await fs.unlink(tempPath); } catch (_) {}
      }
    });

    return this.writeQueue[filename];
  }

  // Settings operations
  getSettings() {
    return { ...this.settings };
  }

  async saveSettings(newSettings) {
    if (typeof newSettings.evolutionUrl === 'string') newSettings.evolutionUrl = newSettings.evolutionUrl.trim();
    if (typeof newSettings.evolutionToken === 'string') newSettings.evolutionToken = newSettings.evolutionToken.trim();
    if (typeof newSettings.evolutionInstance === 'string') newSettings.evolutionInstance = newSettings.evolutionInstance.trim();
    if (typeof newSettings.geminiApiKey === 'string') newSettings.geminiApiKey = newSettings.geminiApiKey.trim();

    this.settings = { ...this.settings, ...newSettings };
    await this._saveFile('settings.json', this.settings);
    return this.settings;
  }

  // Contacts operations
  getContacts() {
    return [...this.contacts];
  }

  async addContact(contact) {
    if (!contact.phone) {
      throw new Error('Phone number is required');
    }
    let cleanPhone = contact.phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('05')) {
      cleanPhone = '972' + cleanPhone.substring(1);
    }
    if (!cleanPhone) {
      throw new Error('Invalid phone number format');
    }

    const exists = this.contacts.find(c => c.phone === cleanPhone);
    if (exists) {
      throw new Error(`Contact with phone ${cleanPhone} already exists`);
    }

    const newContact = {
      phone: cleanPhone,
      name: contact.name || 'Unknown',
      notes: contact.notes || '',
      enabled: contact.enabled !== false,
      addedAt: new Date().toISOString(),
      lastInteractionAt: null,
      messageCount: 0
    };

    this.contacts.push(newContact);
    await this._saveFile('contacts.json', this.contacts);
    return newContact;
  }

  async updateContact(phone, updates) {
    const idx = this.contacts.findIndex(c => c.phone === phone);
    if (idx === -1) {
      throw new Error(`Contact not found: ${phone}`);
    }

    this.contacts[idx] = { ...this.contacts[idx], ...updates };
    await this._saveFile('contacts.json', this.contacts);
    return this.contacts[idx];
  }

  async deleteContact(phone) {
    const idx = this.contacts.findIndex(c => c.phone === phone);
    if (idx === -1) {
      throw new Error(`Contact not found: ${phone}`);
    }

    const removed = this.contacts.splice(idx, 1)[0];
    await this._saveFile('contacts.json', this.contacts);
    return removed;
  }

  // Logs operations
  getLogs(limit = 100) {
    // Return latest logs first
    return this.logs.slice(-limit).reverse();
  }

  async addLog(type, details, message = '', phone = '', isOutgoing = false) {
    const logEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      type, // 'info', 'success', 'warning', 'error', 'message'
      details,
      message,
      phone,
      isOutgoing
    };

    this.logs.push(logEntry);
    
    // Cap logs at 1000 items to prevent file bloat
    if (this.logs.length > 1000) {
      this.logs.shift();
    }

    await this._saveFile('logs.json', this.logs);
    return logEntry;
  }

  // Stats operations
  getTodayDateString() {
    const date = new Date();
    // Format YYYY-MM-DD
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  getStatsForDate(dateStr) {
    return this.stats[dateStr] || { incoming: 0, outgoing: 0, group: 0, total: 0 };
  }

  async incrementStat(type) { // 'incoming', 'outgoing', 'group'
    const today = this.getTodayDateString();
    
    if (!this.stats[today]) {
      this.stats[today] = { incoming: 0, outgoing: 0, group: 0, total: 0 };
    }

    this.stats[today][type]++;
    this.stats[today].total = this.stats[today].incoming + this.stats[today].outgoing;

    await this._saveFile('stats.json', this.stats);
    return this.stats[today];
  }

  getStatsSummary() {
    return { ...this.stats };
  }
}

const db = new JSONDatabase();
export default db;
