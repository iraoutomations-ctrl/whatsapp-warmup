import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// Shared phone normalization: strips non-digits, maps a leading Israeli
// mobile prefix ('05...') to the international form ('972...'). Used by
// both the admin "add contact" flow and the public leaderboard signup.
function normalizePhone(phone) {
  let cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.startsWith('05')) {
    cleanPhone = '972' + cleanPhone.substring(1);
  }
  return cleanPhone;
}

class JSONDatabase {
  constructor() {
    this.settings = {};
    this.contacts = [];
    this.logs = [];
    this.stats = {};
    this.chats = [];
    this.votes = [];
    this.isInitialized = false;
    this.writeQueue = {}; // Map to queue concurrent writes for each file type

    // Live "is typing right now" indicator - deliberately in-memory only,
    // never persisted. It's a multi-second transient flag; writing it to
    // disk would be pure write-amplification for something that doesn't
    // need to survive a restart.
    this.typingPhones = new Set();
  }

  markTyping(phone) { this.typingPhones.add(phone); }
  clearTyping(phone) { this.typingPhones.delete(phone); }
  isTyping(phone) { return this.typingPhones.has(phone); }

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
        webhookSecret: process.env.WEBHOOK_SECRET || '',
        nightRestStart: '23:00',
        nightRestEnd: '08:00',
        activeMinIntervalMinutes: 30,
        activeMaxIntervalMinutes: 90,
        week1Limit: 20,
        week2Limit: 60,
        groupsEnabled: true,
        groupReplyLimitPerDay: 2,
        maxRepliesPerContactPerDay: 4,
        maxSilentReadsPerDay: 4,
        adminPin: process.env.ADMIN_PIN || 'Liran!192837',
        nextActiveWarmupAt: '',
        nextActiveWarmupTargetPhone: '',
        nextActiveWarmupTargetName: '',
        leaderboardRetentionDays: 3,
        leaderboardMinVotesToKeep: 3,
        leaderboardTopNAlwaysKept: 10,
        leaderboardMinMessagesToPublish: 4,
        leaderboardTopics: ['עבודה', 'לימודים', 'סתם שיחת חולין', 'חברים'],
        botWhatsappNumber: ''
      });

      // Initialize Contacts
      this.contacts = await this._loadOrInitFile('contacts.json', []);

      // Initialize Logs
      this.logs = await this._loadOrInitFile('logs.json', []);

      // Initialize Stats
      this.stats = await this._loadOrInitFile('stats.json', {});

      // Initialize Chats (leaderboard) and Votes
      this.chats = await this._loadOrInitFile('chats.json', []);
      this.votes = await this._loadOrInitFile('votes.json', []);

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
    const cleanPhone = normalizePhone(contact.phone);
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
      messageCount: 0,
      leaderboardConsent: false,
      leaderboardDisplayAlias: '',
      leaderboardConsentAt: null
    };

    this.contacts.push(newContact);
    await this._saveFile('contacts.json', this.contacts);
    return newContact;
  }

  // Public leaderboard signup: upserts a contact by phone, recording their
  // explicit consent to have their chat + chosen display name shown
  // publicly. The chosen topic is stored as the contact's context notes,
  // reusing the same field generateStarter() already reads.
  async registerLeaderboardSignup({ phone, displayAlias, topic }) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      throw new Error('Invalid phone number format');
    }
    if (!displayAlias || !String(displayAlias).trim()) {
      throw new Error('displayAlias is required');
    }

    const consentFields = {
      leaderboardConsent: true,
      leaderboardDisplayAlias: String(displayAlias).trim(),
      leaderboardConsentAt: new Date().toISOString()
    };

    const existing = this.contacts.find(c => c.phone === cleanPhone);
    if (existing) {
      return this.updateContact(cleanPhone, { ...consentFields, notes: topic || existing.notes });
    }

    const newContact = {
      phone: cleanPhone,
      name: displayAlias,
      notes: topic || '',
      enabled: true,
      addedAt: new Date().toISOString(),
      lastInteractionAt: null,
      messageCount: 0,
      ...consentFields
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

    // Real-time leaderboard auto-publish: only for actual chat messages,
    // and only for contacts who explicitly consented at signup. Wrapped so
    // a leaderboard bug can never break the core message-logging pipeline.
    if (type === 'message' && phone && message) {
      try {
        await this._autoAppendLeaderboardMessage(phone, message, isOutgoing);
      } catch (err) {
        console.error('Leaderboard auto-publish failed:', err);
      }
    }

    return logEntry;
  }

  // Appends a live chat message to the consenting contact's leaderboard
  // entry and auto-publishes once it crosses the minimum message threshold.
  // No content filtering of any kind - text is stored exactly as sent.
  async _autoAppendLeaderboardMessage(phone, text, isOutgoing) {
    const contact = this.contacts.find(c => c.phone === phone);
    if (!contact || !contact.leaderboardConsent) return;

    let chat = this.getChatByPhone(phone);
    if (!chat) {
      chat = {
        id: crypto.randomUUID(),
        contactPhone: phone,
        displayAlias: contact.leaderboardDisplayAlias || contact.name || 'משתתף',
        messages: [],
        consentStatus: 'approved',
        status: 'draft',
        createdAt: new Date().toISOString(),
        publishedAt: null,
        voteCount: 0
      };
      this.chats.push(chat);
    }

    chat.messages.push({ text, isOutgoing, ts: new Date().toISOString() });

    const threshold = this.settings.leaderboardMinMessagesToPublish || 4;
    if (chat.status === 'draft' && chat.messages.length >= threshold) {
      chat.status = 'published';
      chat.publishedAt = new Date().toISOString();
    }

    await this._saveFile('chats.json', this.chats);
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

  // ---- Leaderboard chats operations ----

  // Public-facing serializer: explicit allow-list so contactPhone / internal
  // fields can never leak through a route that forgets to filter.
  // contactStatus is pre-computed by the caller (server.js, via
  // config.js's getContactStatus) and passed in - this class never imports
  // config.js itself to avoid a circular import with config.js's own
  // `import db from './database.js'`.
  toPublicChat(chat, contactStatus) {
    return {
      id: chat.id,
      displayAlias: chat.displayAlias,
      messages: chat.messages,
      voteCount: chat.voteCount,
      contactStatus
    };
  }

  // All chats, unfiltered (admin use only).
  getAllChats() {
    return [...this.chats];
  }

  // Published, non-archived chats for the public leaderboard. getStatusFn,
  // if provided, is called with each chat's contactPhone and its return
  // value attached as contactStatus on the public-safe serialized chat.
  getPublishedChats(getStatusFn) {
    return this.chats
      .filter(c => c.status === 'published')
      .map(c => this.toPublicChat(c, getStatusFn ? getStatusFn(c.contactPhone) : undefined));
  }

  getChatById(id) {
    return this.chats.find(c => c.id === id) || null;
  }

  // Latest non-archived chat for a phone (draft or published). Archived
  // chats never match - an emergency hide must stay hidden even if the
  // same contact keeps messaging; a fresh chat starts instead.
  getChatByPhone(phone) {
    const candidates = this.chats.filter(c => c.contactPhone === phone && c.status !== 'archived');
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, c) => (c.createdAt > latest.createdAt ? c : latest));
  }

  async addChat({ contactPhone, displayAlias, messages }) {
    if (!contactPhone) {
      throw new Error('contactPhone is required');
    }
    const newChat = {
      id: crypto.randomUUID(),
      contactPhone,
      displayAlias: displayAlias || `משתתף #${this.chats.length + 1}`,
      messages: Array.isArray(messages) ? messages : [],
      consentStatus: 'pending', // 'pending' | 'approved' | 'rejected'
      status: 'draft', // 'draft' | 'published' | 'archived'
      createdAt: new Date().toISOString(),
      publishedAt: null,
      voteCount: 0
    };
    this.chats.push(newChat);
    await this._saveFile('chats.json', this.chats);
    return newChat;
  }

  // Internal, unrestricted field merge - used by updateChat's allow-listed
  // wrapper below AND by the guarded mutators (setConsentStatus/publishChat/
  // archiveChat) that need to touch status/consentStatus/publishedAt after
  // already enforcing their own rules.
  async _setChatFields(id, fields) {
    const idx = this.chats.findIndex(c => c.id === id);
    if (idx === -1) {
      throw new Error(`Chat not found: ${id}`);
    }
    this.chats[idx] = { ...this.chats[idx], ...fields };
    await this._saveFile('chats.json', this.chats);
    return this.chats[idx];
  }

  // Content-only allow-list for the generic admin edit route.
  // status/consentStatus/publishedAt/voteCount must go through their
  // dedicated mutators so a generic edit can never bypass the consent gate
  // and push a real person's chat public without approval.
  async updateChat(id, updates) {
    const { contactPhone, displayAlias, messages } = updates;
    const safeUpdates = {};
    if (contactPhone !== undefined) safeUpdates.contactPhone = contactPhone;
    if (displayAlias !== undefined) safeUpdates.displayAlias = displayAlias;
    if (messages !== undefined) safeUpdates.messages = messages;
    return this._setChatFields(id, safeUpdates);
  }

  async setConsentStatus(id, consentStatus) {
    if (!['pending', 'approved', 'rejected'].includes(consentStatus)) {
      throw new Error(`Invalid consentStatus: ${consentStatus}`);
    }
    return this._setChatFields(id, { consentStatus });
  }

  async publishChat(id) {
    const chat = this.getChatById(id);
    if (!chat) {
      throw new Error(`Chat not found: ${id}`);
    }
    if (chat.consentStatus !== 'approved') {
      throw new Error('Chat cannot be published without approved consent');
    }
    return this._setChatFields(id, { status: 'published', publishedAt: new Date().toISOString() });
  }

  // Soft-delete: the chat and its raw content are kept on disk, just hidden
  // from the public leaderboard. Never remove rows from chats.json here.
  async archiveChat(id) {
    return this._setChatFields(id, { status: 'archived' });
  }

  // Explicit self-serve opt-out (triggered from the WhatsApp chat itself,
  // see server.js webhook handler): stops future messages and, since
  // someone who no longer wants contact almost certainly doesn't want their
  // past chat staying public either, revokes leaderboard consent and
  // archives their current chat if they have one.
  async optOutContact(phone) {
    const contact = this.contacts.find(c => c.phone === phone);
    if (contact) {
      await this.updateContact(phone, { enabled: false, leaderboardConsent: false });
    }
    const chat = this.getChatByPhone(phone);
    if (chat && chat.status !== 'archived') {
      await this.archiveChat(chat.id);
    }
  }

  // Daily sweep: archives published chats past retention that didn't earn
  // enough votes, unless they're in the current top-N leaderboard.
  async sweepExpiredChats({ retentionDays, minVotesToKeep, topNAlwaysKept }) {
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    const publishedSortedByVotes = this.chats
      .filter(c => c.status === 'published')
      .sort((a, b) => b.voteCount - a.voteCount);
    const protectedIds = new Set(publishedSortedByVotes.slice(0, topNAlwaysKept).map(c => c.id));

    const archivedIds = [];
    for (const chat of this.chats) {
      if (chat.status !== 'published' || !chat.publishedAt) continue;
      if (protectedIds.has(chat.id)) continue;
      const age = now - new Date(chat.publishedAt).getTime();
      if (age >= retentionMs && chat.voteCount < minVotesToKeep) {
        chat.status = 'archived';
        archivedIds.push(chat.id);
      }
    }

    if (archivedIds.length > 0) {
      await this._saveFile('chats.json', this.chats);
    }
    return archivedIds;
  }

  // ---- Votes operations ----

  // Synchronous dedup-check + push (no await between them) so two concurrent
  // requests from the same voter can't both pass the "already voted" check
  // before either is recorded — Node's single-threaded event loop guarantees
  // no interleaving as long as nothing here yields control mid-check.
  async recordVote(chatId, voterId) {
    const chat = this.getChatById(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    if (chat.status !== 'published') {
      throw new Error('Chat is not open for voting');
    }

    const alreadyVoted = this.votes.some(v => v.chatId === chatId && v.voterId === voterId);
    if (alreadyVoted) {
      throw new Error('Already voted for this chat');
    }

    this.votes.push({ chatId, voterId, createdAt: new Date().toISOString() });
    chat.voteCount += 1;

    await Promise.all([
      this._saveFile('votes.json', this.votes),
      this._saveFile('chats.json', this.chats)
    ]);

    return { chatId, voteCount: chat.voteCount };
  }
}

const db = new JSONDatabase();
export default db;
