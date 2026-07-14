import dotenv from 'dotenv';
import db from './database.js';

dotenv.config();

// Global, instance-agnostic config: the Nehorai persona/voice, admin
// access, and leaderboard-wide policy aren't tied to any one WhatsApp
// number. Use this instead of getConfig() for things that don't vary
// per-instance (gemini.js, requireAdmin, leaderboard topic/retention logic).
export function getGlobalConfig() {
  const dbSettings = db.getSettings();
  return {
    port: process.env.PORT || 3000,
    geminiApiKey: dbSettings.geminiApiKey || process.env.GEMINI_API_KEY || '',
    adminPin: dbSettings.adminPin || process.env.ADMIN_PIN || 'Liran!192837',
    leaderboardRetentionDays: dbSettings.leaderboardRetentionDays !== undefined ? Number(dbSettings.leaderboardRetentionDays) : 3,
    leaderboardMinVotesToKeep: dbSettings.leaderboardMinVotesToKeep !== undefined ? Number(dbSettings.leaderboardMinVotesToKeep) : 3,
    leaderboardTopNAlwaysKept: dbSettings.leaderboardTopNAlwaysKept !== undefined ? Number(dbSettings.leaderboardTopNAlwaysKept) : 10,
    leaderboardMinMessagesToPublish: dbSettings.leaderboardMinMessagesToPublish !== undefined ? Number(dbSettings.leaderboardMinMessagesToPublish) : 4,
    leaderboardTopics: Array.isArray(dbSettings.leaderboardTopics) ? dbSettings.leaderboardTopics : ['עבודה', 'לימודים', 'סתם שיחת חולין', 'חברים']
  };
}

// Per-instance ("bot number") config. Deliberately throws on a
// missing/invalid instanceId rather than silently falling back to the
// default instance - a silent fallback would make any call site a refactor
// missed *look* fine (it would just always act on the default number) while
// quietly breaking multi-tenancy for every other instance. A loud throw
// surfaces the mistake immediately during testing instead of in production.
export function getConfig(instanceId) {
  if (!instanceId) {
    throw new Error('getConfig(instanceId) requires an instanceId - use getGlobalConfig() for instance-agnostic settings.');
  }
  const instance = db.getInstanceById(instanceId);
  if (!instance) {
    throw new Error(`getConfig: unknown instanceId "${instanceId}"`);
  }

  return {
    id: instance.id,
    label: instance.label,
    phone: instance.phone || '',
    isDefault: !!instance.isDefault,
    // warmupExempt bypasses quota/night-rest/contact-cap gating below -
    // deliberately independent from isDefault (see database.js's
    // defaultInstanceFields comment): a number can be the routing default
    // while still mid-warmup and needing full protection.
    warmupExempt: !!instance.warmupExempt,
    warmupEnabled: instance.warmupEnabled,
    currentDay: instance.currentDay,
    lastDayUpdateAt: instance.lastDayUpdateAt,

    evolutionUrl: instance.evolutionUrl || '',
    evolutionToken: instance.evolutionToken || '',
    evolutionInstance: instance.evolutionInstance || '',
    webhookSecret: instance.webhookSecret || '',

    nightRestEnabled: instance.nightRestEnabled !== false,
    nightRestStart: instance.nightRestStart || '23:00',
    nightRestEnd: instance.nightRestEnd || '08:00',
    activeMinIntervalMinutes: instance.activeMinIntervalMinutes || 30,
    activeMaxIntervalMinutes: instance.activeMaxIntervalMinutes || 90,
    week1Limit: instance.week1Limit || 20,
    week2Limit: instance.week2Limit || 60,
    groupsEnabled: instance.groupsEnabled !== false,
    groupReplyLimitPerDay: instance.groupReplyLimitPerDay || 2,
    maxRepliesPerContactPerDay: instance.maxRepliesPerContactPerDay !== undefined ? Number(instance.maxRepliesPerContactPerDay) : 4,
    maxSilentReadsPerDay: instance.maxSilentReadsPerDay !== undefined ? Number(instance.maxSilentReadsPerDay) : 4,
    maxConsecutiveIgnoredStarters: instance.maxConsecutiveIgnoredStarters !== undefined ? Number(instance.maxConsecutiveIgnoredStarters) : 3,

    busySimulationEnabled: instance.busySimulationEnabled !== false,
    busySimulationChance: instance.busySimulationChance !== undefined ? Number(instance.busySimulationChance) : 0.15,
    minBusyDelayMinutes: instance.minBusyDelayMinutes !== undefined ? Number(instance.minBusyDelayMinutes) : 5,
    maxBusyDelayMinutes: instance.maxBusyDelayMinutes !== undefined ? Number(instance.maxBusyDelayMinutes) : 30,

    nextActiveWarmupAt: instance.nextActiveWarmupAt || '',
    nextActiveWarmupTargetPhone: instance.nextActiveWarmupTargetPhone || '',
    nextActiveWarmupTargetName: instance.nextActiveWarmupTargetName || '',

    nightQueue: Array.isArray(instance.nightQueue) ? instance.nightQueue : [],
    delayedReplies: Array.isArray(instance.delayedReplies) ? instance.delayedReplies : [],
    pendingOptOuts: Array.isArray(instance.pendingOptOuts) ? instance.pendingOptOuts : [],

    lastStatusPostDate: instance.lastStatusPostDate || '',
    lastStatusPostType: instance.lastStatusPostType || '',
    lastStatusPostCaption: instance.lastStatusPostCaption || '',
    lastStatusPostText: instance.lastStatusPostText || '',
    lastStatusPostFile: instance.lastStatusPostFile || ''
  };
}

/**
 * Returns current date/time parts in the Asia/Jerusalem timezone.
 * Essential for cloud deployments (UTC environments) to ensure
 * night sleep and weekend rules map correctly to Israel local time.
 */
export function getIsraelTime() {
  const options = {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(new Date());

  const getVal = (type) => Number(parts.find(p => p.type === type).value);

  const hour = getVal('hour');
  const minute = getVal('minute');

  // Determine weekday in Israel (Sun=0, Mon=1, ..., Sat=6)
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(new Date());
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayNum = dayNames.indexOf(dayName);

  return {
    hour,
    minute,
    weekdayNum
  };
}

// isDefault !== warmupExempt (see getConfig above) - a number still mid-warmup
// always goes through the real night-rest math below even if it's the
// default/routing instance.
export function isNightTime(instanceId, targetDate = null) {
  const config = getConfig(instanceId);
  if (config.warmupExempt) return false;

  let hour, minute;
  if (targetDate) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      hour: 'numeric', minute: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(targetDate);
    hour = Number(parts.find(p => p.type === 'hour').value);
    minute = Number(parts.find(p => p.type === 'minute').value);
  } else {
    const timeParts = getIsraelTime();
    hour = timeParts.hour;
    minute = timeParts.minute;
  }

  const startStr = config.nightRestStart || '23:00';
  const endStr = config.nightRestEnd || '08:00';

  // Defensive splitting in case value format is invalid/corrupted
  let startHour = 23, startMin = 0;
  let endHour = 8, endMin = 0;

  if (startStr.includes(':')) {
    const parts = startStr.split(':').map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      startHour = parts[0];
      startMin = parts[1];
    }
  }

  if (endStr.includes(':')) {
    const parts = endStr.split(':').map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      endHour = parts[0];
      endMin = parts[1];
    }
  }

  const nowMinutes = hour * 60 + minute;
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  if (startMinutes > endMinutes) {
    // Overlap midnight (e.g. 23:00 to 08:00)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  } else {
    // Standard range (e.g. 01:00 to 07:00)
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
}

export function isWeekend() {
  const { weekdayNum } = getIsraelTime();
  // Israeli weekend is Friday (5) and Saturday (6)
  return weekdayNum === 5 || weekdayNum === 6;
}

export function getDailyQuota(instanceId) {
  const config = getConfig(instanceId);
  if (config.warmupExempt) return Infinity;

  const baseLimit = config.currentDay <= 7 ? config.week1Limit : config.week2Limit;

  // If weekend, cut daily limits in half
  if (isWeekend()) {
    return Math.floor(baseLimit / 2);
  }
  return baseLimit;
}

// Shared dynamic per-contact daily reply cap (base limit ± a small
// per-phone-per-day hash variance). This used to be copy-pasted inline in
// server.js and twice in scheduler.js - extracted here so contact-status
// reporting can never drift from the actual enforcement logic.
export function computeDynamicContactCap(phone, instanceId) {
  const config = getConfig(instanceId);
  const todayStr = db.getTodayDateString();
  // Sourced from the contact's own persistent chats.json record, not the
  // rotating global logs.json - that log is capped at 1000 entries shared
  // across every contact/instance, so as more numbers/clients are added a
  // busy day elsewhere could push a contact's own entries out of the
  // window and make this cap silently under-count. chats.json has no such
  // shared cap.
  const chat = db.getChatByPhone(phone);
  const todayContactMessages = (chat?.messages || []).filter(m =>
    m.ts && m.ts.startsWith(todayStr)
  );

  if (config.warmupExempt) {
    return { count: todayContactMessages.length, cap: Infinity, reached: false };
  }

  const baseCap = config.maxRepliesPerContactPerDay || 4;
  const hashStr = phone + todayStr;
  let hash = 0;
  for (let i = 0; i < hashStr.length; i++) {
    hash = (hash << 5) - hash + hashStr.charCodeAt(i);
  }
  const variance = (Math.abs(hash) % 3) - 1; // -1, 0, or +1
  const dynamicMaxReplies = Math.max(2, baseCap + variance);
  return { count: todayContactMessages.length, cap: dynamicMaxReplies, reached: todayContactMessages.length >= dynamicMaxReplies };
}

// Has this instance hit its own global daily send quota (not per-contact)?
export function isDailyQuotaReached(instanceId) {
  const stats = db.getStatsForInstanceDate(instanceId, db.getTodayDateString());
  return stats.outgoing >= getDailyQuota(instanceId);
}

// Live per-contact status for the leaderboard UI (public + admin).
// Priority: typing (transient, in-memory) > today's per-contact cap reached
// > global night rest > busy-ghosting delay queue > ready. Returns a plain
// key - the actual Nehorai-voice wording lives in the front-end.
export function getContactStatus(phone, instanceId) {
  if (db.isTyping(phone)) return 'typing';

  const config = getConfig(instanceId);
  if (computeDynamicContactCap(phone, instanceId).reached) return 'quota_reached';

  if (config.nightRestEnabled && isNightTime(instanceId)) return 'sleeping';

  if ((config.delayedReplies || []).some(r => r.phone === phone)) return 'delayed';

  return 'ready';
}
