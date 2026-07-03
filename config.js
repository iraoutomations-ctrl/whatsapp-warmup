import dotenv from 'dotenv';
import db from './database.js';

dotenv.config();

export function getConfig() {
  const dbSettings = db.getSettings();
  
  return {
    port: process.env.PORT || 3000,
    warmupEnabled: dbSettings.warmupEnabled,
    currentDay: dbSettings.currentDay,
    
    // API configs (from DB with Env fallbacks)
    evolutionUrl: dbSettings.evolutionUrl || process.env.EVOLUTION_API_URL || '',
    evolutionToken: dbSettings.evolutionToken || process.env.EVOLUTION_API_TOKEN || '',
    evolutionInstance: dbSettings.evolutionInstance || process.env.EVOLUTION_API_INSTANCE || '',
    geminiApiKey: dbSettings.geminiApiKey || process.env.GEMINI_API_KEY || '',
    
    // Limits & Rules
    nightRestStart: dbSettings.nightRestStart || '23:00',
    nightRestEnd: dbSettings.nightRestEnd || '08:00',
    activeMinIntervalMinutes: dbSettings.activeMinIntervalMinutes || 30,
    activeMaxIntervalMinutes: dbSettings.activeMaxIntervalMinutes || 90,
    week1Limit: dbSettings.week1Limit || 20,
    week2Limit: dbSettings.week2Limit || 60,
    groupsEnabled: dbSettings.groupsEnabled !== false,
    groupReplyLimitPerDay: dbSettings.groupReplyLimitPerDay || 2,
    lastStatusPostDate: dbSettings.lastStatusPostDate || '',
    lastStatusPostType: dbSettings.lastStatusPostType || '',
    lastStatusPostCaption: dbSettings.lastStatusPostCaption || '',
    lastStatusPostText: dbSettings.lastStatusPostText || '',
    lastStatusPostFile: dbSettings.lastStatusPostFile || '',
    
    // Night rest and busy simulation settings
    nightRestEnabled: dbSettings.nightRestEnabled !== false,
    busySimulationEnabled: dbSettings.busySimulationEnabled !== false,
    busySimulationChance: dbSettings.busySimulationChance !== undefined ? Number(dbSettings.busySimulationChance) : 0.15,
    minBusyDelayMinutes: dbSettings.minBusyDelayMinutes !== undefined ? Number(dbSettings.minBusyDelayMinutes) : 5,
    maxBusyDelayMinutes: dbSettings.maxBusyDelayMinutes !== undefined ? Number(dbSettings.maxBusyDelayMinutes) : 30,
    
    // Scheduled warmup info
    nextActiveWarmupAt: dbSettings.nextActiveWarmupAt || '',
    nextActiveWarmupTargetPhone: dbSettings.nextActiveWarmupTargetPhone || '',
    nextActiveWarmupTargetName: dbSettings.nextActiveWarmupTargetName || ''
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

export function isNightTime() {
  const config = getConfig();
  const { hour, minute } = getIsraelTime();
  
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

export function getDailyQuota() {
  const config = getConfig();
  const baseLimit = config.currentDay <= 7 ? config.week1Limit : config.week2Limit;
  
  // If weekend, cut daily limits in half
  if (isWeekend()) {
    return Math.floor(baseLimit / 2);
  }
  return baseLimit;
}
