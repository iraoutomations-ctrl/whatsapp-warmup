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

// Per-instance ("bot number") field defaults - this is everything that used
// to live as a single flat value in settings.json before multi-tenant
// support. Mirrors config.js's old getConfig() defaults exactly, so
// migrating an existing single-tenant install into its first instance
// record preserves the live app's current behavior byte-for-byte.
function defaultInstanceFields() {
  return {
    warmupEnabled: false,
    // Two independent concepts, deliberately not the same flag:
    // isDefault = routing/identity ("this is the fallback number the public
    // leaderboard uses when no other instance has spare capacity").
    // warmupExempt = policy/maturity ("this number has actually graduated
    // warmup and no longer needs quota/night-rest protection"). A number
    // can be the default while still mid-warmup (warmupExempt: false) -
    // the admin flips warmupExempt on later, once it's actually earned it.
    warmupExempt: false,
    currentDay: 1,
    lastDayUpdateAt: null,
    phone: '',
    evolutionUrl: '',
    evolutionToken: '',
    evolutionInstance: '',
    webhookSecret: '',
    nightRestEnabled: true,
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
    busySimulationEnabled: true,
    busySimulationChance: 0.15,
    minBusyDelayMinutes: 5,
    maxBusyDelayMinutes: 30,
    nextActiveWarmupAt: '',
    nextActiveWarmupTargetPhone: '',
    nextActiveWarmupTargetName: '',
    nightQueue: [],
    delayedReplies: [],
    pendingOptOuts: [],
    lastStatusPostDate: '',
    lastStatusPostType: '',
    lastStatusPostCaption: '',
    lastStatusPostText: '',
    lastStatusPostFile: ''
  };
}

// Fields that stay global (shared by every instance) rather than moving
// onto per-instance records - the Nehorai persona/voice, admin access, and
// leaderboard-wide policy aren't tied to any one WhatsApp number.
const GLOBAL_SETTINGS_DEFAULTS = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  adminPin: process.env.ADMIN_PIN || 'Liran!192837',
  leaderboardRetentionDays: 3,
  leaderboardMinVotesToKeep: 3,
  leaderboardTopNAlwaysKept: 10,
  leaderboardMinMessagesToPublish: 4,
  leaderboardTopics: ['עבודה', 'לימודים', 'סתם שיחת חולין', 'חברים']
};

class JSONDatabase {
  constructor() {
    this.settings = {};
    this.instances = [];
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

      // Initialize Settings (global-only fields now - per-number fields live
      // on instances.json going forward; see defaultInstanceFields() above).
      // An EXISTING settings.json from a pre-multi-tenant install still
      // loads with all its old per-number fields intact (this default is
      // only used when the file doesn't exist yet) - that's relied on by
      // _loadOrMigrateInstances() below to build the first instance record.
      this.settings = await this._loadOrInitFile('settings.json', { ...GLOBAL_SETTINGS_DEFAULTS });

      // Initialize Contacts
      this.contacts = await this._loadOrInitFile('contacts.json', []);

      // Initialize Logs
      this.logs = await this._loadOrInitFile('logs.json', []);

      // Initialize Stats
      this.stats = await this._loadOrInitFile('stats.json', {});

      // Initialize Chats (leaderboard) and Votes
      this.chats = await this._loadOrInitFile('chats.json', []);
      this.votes = await this._loadOrInitFile('votes.json', []);

      // Initialize bot instances (WhatsApp numbers). Special-cased instead
      // of _loadOrInitFile so "file missing" (never migrated) is never
      // confused with "empty array" (shouldn't be reachable - exactly one
      // instance must always exist as default).
      await this._loadOrMigrateInstances();

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

  // First-boot migration: an existing single-tenant install has no
  // instances.json yet. Synthesize its one (implicit) bot number into a
  // proper instance record from whatever is currently in settings.json (old
  // single-tenant field names), mark it default, and tag every existing
  // contact/chat/log/stats entry with its id - preserves 100% of existing
  // history under the new multi-tenant shape with zero manual work.
  async _loadOrMigrateInstances() {
    const instancesPath = path.join(DATA_DIR, 'instances.json');
    try {
      const raw = await fs.readFile(instancesPath, 'utf-8');
      this.instances = JSON.parse(raw);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error reading instances.json, resetting to defaults:', error);
        this.instances = [];
        return;
      }
    }

    // ENOENT: never migrated yet.
    const legacy = this.settings;
    const now = new Date().toISOString();
    const defaults = defaultInstanceFields();
    const defaultInstance = {
      id: crypto.randomUUID(),
      label: 'ברירת מחדל',
      status: 'active',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      warmupEnabled: legacy.warmupEnabled ?? defaults.warmupEnabled,
      // No legacy field for this - it's a brand-new concept, always starts
      // false on migration. A pre-existing install's number is, by
      // definition, still actively warming (that's the whole reason it has
      // day/quota state worth migrating) - an admin promotes it later.
      warmupExempt: false,
      currentDay: legacy.currentDay ?? defaults.currentDay,
      lastDayUpdateAt: legacy.lastDayUpdateAt ?? defaults.lastDayUpdateAt,
      phone: legacy.botWhatsappNumber || defaults.phone,
      evolutionUrl: legacy.evolutionUrl || defaults.evolutionUrl,
      evolutionToken: legacy.evolutionToken || defaults.evolutionToken,
      evolutionInstance: legacy.evolutionInstance || defaults.evolutionInstance,
      webhookSecret: legacy.webhookSecret || defaults.webhookSecret,
      nightRestEnabled: legacy.nightRestEnabled !== false,
      nightRestStart: legacy.nightRestStart || defaults.nightRestStart,
      nightRestEnd: legacy.nightRestEnd || defaults.nightRestEnd,
      activeMinIntervalMinutes: legacy.activeMinIntervalMinutes || defaults.activeMinIntervalMinutes,
      activeMaxIntervalMinutes: legacy.activeMaxIntervalMinutes || defaults.activeMaxIntervalMinutes,
      week1Limit: legacy.week1Limit || defaults.week1Limit,
      week2Limit: legacy.week2Limit || defaults.week2Limit,
      groupsEnabled: legacy.groupsEnabled !== false,
      groupReplyLimitPerDay: legacy.groupReplyLimitPerDay || defaults.groupReplyLimitPerDay,
      maxRepliesPerContactPerDay: legacy.maxRepliesPerContactPerDay !== undefined ? Number(legacy.maxRepliesPerContactPerDay) : defaults.maxRepliesPerContactPerDay,
      maxSilentReadsPerDay: legacy.maxSilentReadsPerDay !== undefined ? Number(legacy.maxSilentReadsPerDay) : defaults.maxSilentReadsPerDay,
      busySimulationEnabled: legacy.busySimulationEnabled !== false,
      busySimulationChance: legacy.busySimulationChance !== undefined ? Number(legacy.busySimulationChance) : defaults.busySimulationChance,
      minBusyDelayMinutes: legacy.minBusyDelayMinutes !== undefined ? Number(legacy.minBusyDelayMinutes) : defaults.minBusyDelayMinutes,
      maxBusyDelayMinutes: legacy.maxBusyDelayMinutes !== undefined ? Number(legacy.maxBusyDelayMinutes) : defaults.maxBusyDelayMinutes,
      nextActiveWarmupAt: legacy.nextActiveWarmupAt || defaults.nextActiveWarmupAt,
      nextActiveWarmupTargetPhone: legacy.nextActiveWarmupTargetPhone || defaults.nextActiveWarmupTargetPhone,
      nextActiveWarmupTargetName: legacy.nextActiveWarmupTargetName || defaults.nextActiveWarmupTargetName,
      nightQueue: Array.isArray(legacy.nightQueue) ? legacy.nightQueue : defaults.nightQueue,
      delayedReplies: Array.isArray(legacy.delayedReplies) ? legacy.delayedReplies : defaults.delayedReplies,
      pendingOptOuts: Array.isArray(legacy.pendingOptOuts) ? legacy.pendingOptOuts : defaults.pendingOptOuts,
      lastStatusPostDate: legacy.lastStatusPostDate || defaults.lastStatusPostDate,
      lastStatusPostType: legacy.lastStatusPostType || defaults.lastStatusPostType,
      lastStatusPostCaption: legacy.lastStatusPostCaption || defaults.lastStatusPostCaption,
      lastStatusPostText: legacy.lastStatusPostText || defaults.lastStatusPostText,
      lastStatusPostFile: legacy.lastStatusPostFile || defaults.lastStatusPostFile
    };

    this.instances = [defaultInstance];
    await this._saveFile('instances.json', this.instances);
    await this._backfillInstanceId(defaultInstance.id);

    console.log(`Migrated existing installation into default bot instance "${defaultInstance.label}" (${defaultInstance.id}).`);
    await this.addLog('info', `Migrated existing installation into default bot instance (${defaultInstance.id}).`, '', '', false, defaultInstance.id);
  }

  // Tags every pre-existing contact/chat/log entry with the newly
  // synthesized default instance's id, and folds settings.json's old
  // date-keyed stats object under that instance. Runs exactly once, only
  // from the ENOENT branch of _loadOrMigrateInstances above.
  async _backfillInstanceId(defaultInstanceId) {
    let contactsChanged = false;
    for (const contact of this.contacts) {
      if (!contact.instanceId) { contact.instanceId = defaultInstanceId; contactsChanged = true; }
    }
    if (contactsChanged) await this._saveFile('contacts.json', this.contacts);

    let chatsChanged = false;
    for (const chat of this.chats) {
      if (chat.instanceId) continue;
      const owner = this.contacts.find(c => c.phone === chat.contactPhone);
      chat.instanceId = owner?.instanceId || defaultInstanceId;
      chatsChanged = true;
    }
    if (chatsChanged) await this._saveFile('chats.json', this.chats);

    let logsChanged = false;
    for (const log of this.logs) {
      if (log.instanceId) continue;
      const owner = log.phone ? this.contacts.find(c => c.phone === log.phone) : null;
      log.instanceId = owner?.instanceId || null;
      logsChanged = true;
    }
    if (logsChanged) await this._saveFile('logs.json', this.logs);

    // Fold the old flat date-keyed stats.json ({ "2026-07-11": {...} })
    // under the default instance's id, matching the new per-instance shape
    // ({ [instanceId]: { "2026-07-11": {...} } }) that
    // getStatsForInstanceDate/incrementInstanceStat now read and write.
    // This method only ever runs once, from the ENOENT branch of
    // _loadOrMigrateInstances (i.e. the very first boot after this
    // multi-tenant change), so this.stats is guaranteed to still be in the
    // old flat shape here - skipping this step would make every existing
    // day's real outgoing count invisible to the new quota checks (they'd
    // silently read as 0), letting the bot blow past its real daily quota
    // the moment it resumes sending today.
    this.stats = { [defaultInstanceId]: this.stats };
    await this._saveFile('stats.json', this.stats);
  }

  // Settings operations (global-only fields - see GLOBAL_SETTINGS_DEFAULTS)
  getSettings() {
    return { ...this.settings };
  }

  async saveSettings(newSettings) {
    if (typeof newSettings.geminiApiKey === 'string') newSettings.geminiApiKey = newSettings.geminiApiKey.trim();

    this.settings = { ...this.settings, ...newSettings };
    await this._saveFile('settings.json', this.settings);
    return this.settings;
  }

  // ---- Instance (bot number) operations ----

  getInstances() {
    return [...this.instances];
  }

  getInstanceById(id) {
    return this.instances.find(i => i.id === id) || null;
  }

  getDefaultInstance() {
    return this.instances.find(i => i.isDefault) || null;
  }

  async addInstance(fields) {
    if (!fields.label || !String(fields.label).trim()) {
      throw new Error('label is required');
    }
    const now = new Date().toISOString();
    // `...fields` is spread before the identity block below, so a
    // caller-supplied `id`/`isDefault` can never override it - `isDefault`
    // must go through setDefaultInstance() to keep "exactly one default" an
    // enforced invariant.
    const newInstance = {
      ...defaultInstanceFields(),
      ...fields,
      id: crypto.randomUUID(),
      label: String(fields.label).trim(),
      status: 'active',
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    this.instances.push(newInstance);
    await this._saveFile('instances.json', this.instances);
    return newInstance;
  }

  // Allow-listed update - deliberately excludes `id` and `isDefault`.
  // `isDefault` must go through setDefaultInstance() so "exactly one
  // default" stays an enforced invariant, not something a generic PUT can
  // silently violate.
  async updateInstance(id, updates) {
    const idx = this.instances.findIndex(i => i.id === id);
    if (idx === -1) {
      throw new Error(`Instance not found: ${id}`);
    }
    const { id: _ignoredId, isDefault: _ignoredDefault, ...safeUpdates } = updates;
    this.instances[idx] = { ...this.instances[idx], ...safeUpdates, updatedAt: new Date().toISOString() };
    await this._saveFile('instances.json', this.instances);
    return this.instances[idx];
  }

  async setDefaultInstance(id) {
    const target = this.instances.find(i => i.id === id);
    if (!target) {
      throw new Error(`Instance not found: ${id}`);
    }
    const now = new Date().toISOString();
    for (const inst of this.instances) {
      inst.isDefault = inst.id === id;
      inst.updatedAt = now;
    }
    await this._saveFile('instances.json', this.instances);
    return target;
  }

  async deleteInstance(id) {
    const target = this.instances.find(i => i.id === id);
    if (!target) {
      throw new Error(`Instance not found: ${id}`);
    }
    if (target.isDefault) {
      throw new Error('Cannot delete the default instance - set a different instance as default first.');
    }
    const stillOwnsContacts = this.contacts.some(c => c.instanceId === id);
    if (stillOwnsContacts) {
      throw new Error('Cannot delete an instance that still owns contacts - reassign or remove them first.');
    }
    this.instances = this.instances.filter(i => i.id !== id);
    await this._saveFile('instances.json', this.instances);
    return target;
  }

  // Contacts operations
  getContacts() {
    return [...this.contacts];
  }

  // instanceId ties a contact to one bot number for its lifetime (a real
  // person only has one WhatsApp number, so they only ever end up talking
  // to whichever single instance they were first assigned to). Falls back
  // to the current default instance when not explicitly provided, so
  // callers that don't yet know about multi-tenancy still tag contacts
  // correctly as long as there's only one instance.
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
      instanceId: contact.instanceId || this.getDefaultInstance()?.id || null,
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
  //
  // A RETURNING visitor (phone already known) always keeps their original
  // instanceId, no matter what's passed in - they must route back to the
  // number they already have history with, never get reassigned by a fresh
  // load-balancing decision. Only a brand-new phone uses the passed-in
  // instanceId (falling back to the default instance if omitted).
  async registerLeaderboardSignup({ phone, displayAlias, topic, instanceId }) {
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
      instanceId: instanceId || this.getDefaultInstance()?.id || null,
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

  async addLog(type, details, message = '', phone = '', isOutgoing = false, instanceId = null) {
    const logEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      type, // 'info', 'success', 'warning', 'error', 'message'
      details,
      message,
      phone,
      isOutgoing,
      instanceId // admin visibility only - never resolved/required for correctness, since a phone already maps 1:1 to its owning instance
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
        instanceId: contact.instanceId || this.getDefaultInstance()?.id || null, // internal only - never added to toPublicChat's allow-list
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

  // ---- Per-instance stats (multi-tenant) ----
  // Not yet wired to any caller, and this.stats is not yet restructured to
  // this shape either - scheduler.js/server.js/evolution.js still read/write
  // the flat date-keyed this.stats via getStatsForDate/incrementStat above.
  // These methods (and the actual stats.json restructuring + migration of
  // existing data into this shape) land together in Phase 2, so the old
  // methods are never silently reading a "reset to 0" quota mid-migration.

  getStatsForInstanceDate(instanceId, dateStr) {
    return this.stats[instanceId]?.[dateStr] || { incoming: 0, outgoing: 0, group: 0, total: 0 };
  }

  async incrementInstanceStat(instanceId, type) { // 'incoming', 'outgoing', 'group'
    const today = this.getTodayDateString();

    if (!this.stats[instanceId]) this.stats[instanceId] = {};
    if (!this.stats[instanceId][today]) {
      this.stats[instanceId][today] = { incoming: 0, outgoing: 0, group: 0, total: 0 };
    }

    this.stats[instanceId][today][type]++;
    this.stats[instanceId][today].total = this.stats[instanceId][today].incoming + this.stats[instanceId][today].outgoing;

    await this._saveFile('stats.json', this.stats);
    return this.stats[instanceId][today];
  }

  getStatsSummaryForInstance(instanceId) {
    return { ...(this.stats[instanceId] || {}) };
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
  // if provided, is called with each chat's contactPhone and instanceId (the
  // instanceId is used only to resolve the correct per-instance gating
  // config for the status computation - it's never part of what
  // toPublicChat returns to the client) and its return value attached as
  // contactStatus on the public-safe serialized chat.
  getPublishedChats(getStatusFn) {
    return this.chats
      .filter(c => c.status === 'published')
      .map(c => this.toPublicChat(c, getStatusFn ? getStatusFn(c.contactPhone, c.instanceId) : undefined));
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
