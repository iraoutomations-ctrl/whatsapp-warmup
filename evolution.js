import fs from 'fs/promises';
import { getConfig } from './config.js';
import db from './database.js';

/**
 * Helper to make requests to the Evolution API
 */
async function callEvolutionAPI(endpoint, method, body, throwError = false) {
  const config = getConfig();
  
  if (!config.evolutionUrl || !config.evolutionToken || !config.evolutionInstance) {
    console.warn(`Evolution API credentials not configured. Skipping API call to: ${endpoint}`);
    return { success: false, mock: true, message: 'API not configured' };
  }

  const url = `${config.evolutionUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}/${config.evolutionInstance}`;
  
  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolutionToken
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000) // 10 seconds timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Evolution API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    if (throwError) {
      throw error;
    }
    console.error(`Failed to call Evolution API at ${endpoint}:`, error);
    await db.addLog('error', `Evolution API failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Sends a "typing" (composing) state to simulate human latency.
 * @param {string} number - The phone number (with or without suffix)
 * @param {string} presence - 'composing' | 'recording' | 'paused'
 * @param {number} delayMs - Duration in milliseconds to simulate typing
 */
export async function sendTypingState(number, presence = 'composing', delayMs = 3000) {
  const isGroup = number.endsWith('@g.us');
  const cleanNumber = isGroup ? number : number.split('@')[0];
  console.log(`Simulating typing for ${cleanNumber}: ${presence} for ${delayMs}ms`);
  
  await db.addLog('info', `Simulating typing state '${presence}' to ${cleanNumber} for ${delayMs / 1000}s`);

  // Try calling the Evolution v2 sendPresence endpoint, fallback to older updatePresence, fallback to v1 retrievingPresence
  try {
    await callEvolutionAPI('/chat/sendPresence', 'POST', {
      number: cleanNumber,
      presence: presence,
      delay: delayMs
    }, true); // throwError = true
  } catch (err) {
    console.log(`v2 sendPresence failed: ${err.message}, trying updatePresence...`);
    try {
      await callEvolutionAPI('/chat/updatePresence', 'POST', {
        number: cleanNumber,
        presence: presence,
        delay: delayMs
      }, true); // throwError = true
    } catch (updateErr) {
      console.log(`updatePresence failed: ${updateErr.message}, trying v1 retrievingPresence...`);
      try {
        await callEvolutionAPI('/chat/retrievingPresence', 'POST', {
          number: cleanNumber,
          delay: delayMs,
          presence: presence
        }, true); // throwError = true
      } catch (v1Err) {
        console.warn('Failed to set typing presence via all fallbacks:', v1Err.message);
      }
    }
  }

  // Delay the local execution to wait out the typing simulation
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Helper to introduce minor, realistic typos in Hebrew words (5% chance)
 */
function introduceTypo(text) {
  if (!text || (text.startsWith('[') && text.endsWith(']')) || text.length < 5) return text;
  
  // 5% chance of introducing a typo
  if (Math.random() > 0.05) return text;

  const words = text.split(' ');
  if (words.length === 0) return text;

  // Find index of Hebrew words that are eligible (length >= 3, pure letters)
  const eligibleIndices = [];
  const hebrewWordRegex = /^[\u0590-\u05fe]{3,}$/;
  for (let i = 0; i < words.length; i++) {
    if (hebrewWordRegex.test(words[i])) {
      eligibleIndices.push(i);
    }
  }

  if (eligibleIndices.length === 0) return text;
  const targetWordIdx = eligibleIndices[Math.floor(Math.random() * eligibleIndices.length)];
  let word = words[targetWordIdx];

  const typoType = Math.floor(Math.random() * 3);
  if (typoType === 0) {
    // 1. Duplicate last character (e.g., "סבבה" -> "סבבהה", "כן" -> "כןן")
    word = word + word[word.length - 1];
  } else if (typoType === 1 && word.length > 3) {
    // 2. Swap two adjacent middle characters (e.g., "בוקר" -> "בוק ר")
    const idx = Math.floor(Math.random() * (word.length - 2)) + 1;
    const chars = word.split('');
    const temp = chars[idx];
    chars[idx] = chars[idx + 1];
    chars[idx + 1] = temp;
    word = chars.join('');
  } else if (typoType === 2 && word.length > 3) {
    // 3. Drop a character in the middle (e.g., "מצוין" -> "מצין")
    const idx = Math.floor(Math.random() * (word.length - 2)) + 1;
    word = word.slice(0, idx) + word.slice(idx + 1);
  }

  words[targetWordIdx] = word;
  const typoedText = words.join(' ');
  console.log(`Typo introduced: "${text}" -> "${typoedText}"`);
  return typoedText;
}

/**
 * Sends a text message to a number.
 * Automatically handles sending typing presence beforehand.
 */
export async function sendMessage(number, text, simulateTyping = true) {
  // If message contains double-pipe '||', split and send sequentially with a short stagger
  if (text.includes('||')) {
    const parts = text.split('||').map(p => p.trim()).filter(Boolean);
    let allSuccess = true;
    for (let i = 0; i < parts.length; i++) {
      const success = await sendMessage(number, parts[i], simulateTyping);
      allSuccess = allSuccess && success;
      
      // Delay slightly between bubbles
      if (i < parts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
    return allSuccess;
  }

  // Apply minor typo simulation (5% chance per bubble)
  const processedText = introduceTypo(text);

  const isGroup = number.endsWith('@g.us');
  const cleanNumber = isGroup ? number : number.split('@')[0];
  
  if (simulateTyping) {
    // Determine typing delay based on message length (approx. 50ms per character, min 2s, max 6s)
    const delay = Math.min(Math.max(processedText.length * 50, 2000), 6000);
    await sendTypingState(cleanNumber, 'composing', delay);
  }

  console.log(`Sending message to ${cleanNumber}: "${processedText}"`);

  // We attempt to send using the advanced message format which supports composing options natively,
  // but if the instance setup is custom, we also include a fallback or simple keys.
  const payload = {
    number: cleanNumber,
    options: {
      delay: 0,
      presence: 'paused',
      linkPreview: true
    },
    textMessage: {
      text: processedText
    },
    // Adding standard fallback keys for different Evolution versions
    text: processedText
  };

  const result = await callEvolutionAPI('/message/sendText', 'POST', payload);
  
  if (result.success) {
    await db.incrementStat('outgoing');
    await db.addLog('message', `Sent: ${text}`, text, cleanNumber, true);
    
    // Update contact's last interaction date
    try {
      const contacts = db.getContacts();
      const contact = contacts.find(c => c.phone === cleanNumber);
      if (contact) {
        await db.updateContact(cleanNumber, {
          lastInteractionAt: new Date().toISOString(),
          messageCount: contact.messageCount + 1
        });
      }
    } catch (e) {
      console.error('Failed to update contact interaction timestamp:', e);
    }
  } else if (result.mock) {
    // If running in offline test mode
    await db.incrementStat('outgoing');
    await db.addLog('message', `[MOCK SEND] Sent: ${text}`, text, cleanNumber, true);
  }

  return result.success || result.mock;
}

/**
 * Sends a read receipt for a chat/message.
 */
export async function markRead(remoteJid, msgKey = null) {
  console.log(`Sending read receipt for JID: ${remoteJid}`);
  const isGroup = remoteJid.endsWith('@g.us');
  const cleanNumber = isGroup ? remoteJid : remoteJid.split('@')[0];

  // If a specific message key was passed (v2 markMessageAsRead format)
  if (msgKey && msgKey.id) {
    try {
      const result = await callEvolutionAPI('/chat/markMessageAsRead', 'POST', {
        readMessages: [
          {
            remoteJid: remoteJid,
            fromMe: msgKey.fromMe || false,
            id: msgKey.id
          }
        ]
      }, true); // throwError = true
      return result.success || result.mock;
    } catch (err) {
      console.log(`v2 markMessageAsRead failed: ${err.message}, trying other fallbacks...`);
    }
  }

  // Fallback 1: Try v2 readMessages endpoint (just JID/number)
  try {
    const result = await callEvolutionAPI('/chat/readMessages', 'POST', {
      number: cleanNumber
    }, true); // throwError = true
    return result.success || result.mock;
  } catch (err) {
    console.log(`v2 readMessages failed: ${err.message}, trying v1 markRead...`);
    try {
      const payload = {
        read: true,
        wids: [remoteJid]
      };
      const result = await callEvolutionAPI('/chat/markRead', 'POST', payload, true);
      return result.success || result.mock;
    } catch (v1Err) {
      console.warn('Failed to send read receipt via fallback:', v1Err.message);
    }
  }
  return false;
}

/**
 * Sends an emoji reaction to a specific message.
 */
export async function sendReaction(number, emoji, msgKeyOrId) {
  const isGroup = number.endsWith('@g.us');
  const cleanNumber = isGroup ? number : number.split('@')[0];
  const targetJid = isGroup ? number : `${cleanNumber}@s.whatsapp.net`;
  
  let keyPayload;
  if (msgKeyOrId && typeof msgKeyOrId === 'object' && msgKeyOrId.id) {
    keyPayload = {
      remoteJid: msgKeyOrId.remoteJid || targetJid,
      fromMe: msgKeyOrId.fromMe || false,
      id: msgKeyOrId.id
    };
  } else {
    keyPayload = {
      remoteJid: targetJid,
      fromMe: false,
      id: msgKeyOrId
    };
  }

  console.log(`Reacting with ${emoji} to message ${keyPayload.id} on ${cleanNumber}`);

  // Try calling the Evolution v2 sendReaction format first
  try {
    const payload = {
      key: keyPayload,
      reaction: emoji
    };
    const result = await callEvolutionAPI('/message/sendReaction', 'POST', payload, true); // throwError = true
    if (result.success) {
      await db.incrementStat('outgoing');
      await db.addLog('success', `Reacted with ${emoji} to message`, emoji, cleanNumber, true);
      return true;
    }
  } catch (err) {
    console.log(`v2 sendReaction failed: ${err.message}, trying v1 sendReaction...`);
    try {
      const payload = {
        number: cleanNumber,
        reaction: emoji,
        messageId: keyPayload.id
      };
      const result = await callEvolutionAPI('/message/sendReaction', 'POST', payload, true);
      if (result.success) {
        await db.incrementStat('outgoing');
        await db.addLog('success', `Reacted with ${emoji} to message (v1 fallback)`, emoji, cleanNumber, true);
        return true;
      }
    } catch (v1Err) {
      console.warn('Failed to send reaction via fallback:', v1Err.message);
      await db.addLog('warning', `Failed to send reaction ${emoji}: ${v1Err.message}`);
    }
  }

  return false;
}

/**
 * Sends a media message (images, videos, etc.) to a phone/group/status.
 */
export async function sendMedia(number, base64Data, mediaType = 'image', fileName = 'file.png', caption = '') {
  const isGroup = number.endsWith('@g.us') || number === 'status@broadcast';
  const cleanNumber = isGroup ? number : number.split('@')[0];

  console.log(`Sending media (${mediaType}) to ${cleanNumber}: "${caption}"`);

  const payload = {
    number: cleanNumber,
    media: base64Data,
    mediaType: mediaType, // v1 fallback
    mediatype: mediaType, // v2 required (lowercase)
    fileName: fileName,
    caption: caption
  };

  const result = await callEvolutionAPI('/message/sendMedia', 'POST', payload);

  if (result.success) {
    await db.incrementStat('outgoing');
    await db.addLog('message', `Sent Media (${mediaType}): ${caption}`, caption, cleanNumber, true);
  } else if (result.mock) {
    await db.incrementStat('outgoing');
    await db.addLog('message', `[MOCK MEDIA] Sent Media (${mediaType}): ${caption}`, caption, cleanNumber, true);
  }

  return result.success || result.mock;
}

/**
 * Sends a status update (text or media) to WhatsApp Status/Stories.
 */
export async function sendStatus(type, content, caption = '') {
  console.log(`Publishing WhatsApp status: type=${type}, caption="${caption}"`);
  
  try {
    const flatPayload = {
      type: type,
      content: content,
      caption: caption || content,
      text: content,
      message: content,
      allContacts: true,
      statusJidList: ['status@broadcast']
    };
    
    if (type === 'text') {
      flatPayload.backgroundColor = '#128C7E'; // WhatsApp Teal Green
      flatPayload.font = 1;
    }
    
    // 1. Try dedicated /message/sendStatus endpoint
    let success = false;
    try {
      const res = await callEvolutionAPI('/message/sendStatus', 'POST', flatPayload);
      if (res.success || res.mock) success = true;
    } catch (err) {
      console.log(`Endpoint /message/sendStatus failed: ${err.message}`);
    }

    // 2. ALWAYS also fire direct broadcast endpoint targeting 'status@broadcast'
    try {
      if (type === 'text') {
        const resBroadcast = await callEvolutionAPI('/message/sendText', 'POST', {
          number: 'status@broadcast',
          text: content
        });
        if (resBroadcast.success || resBroadcast.mock) success = true;
      } else if (type === 'image') {
        const resBroadcast = await callEvolutionAPI('/message/sendMedia', 'POST', {
          number: 'status@broadcast',
          mediatype: 'image',
          media: content,
          caption: caption
        });
        if (resBroadcast.success || resBroadcast.mock) success = true;
      }
    } catch (err2) {
      console.log(`Direct status@broadcast dispatch failed: ${err2.message}`);
    }

    if (success) {
      return true;
    }
  } catch (err) {
    console.error('Failed to publish status via sendStatus API:', err.message);
    await db.addLog('error', `Failed to publish WhatsApp status: ${err.message}`);
  }
  return false;
}

/**
 * Posts a text status update to WhatsApp Status.
 */
export async function sendStatusText(text) {
  console.log(`Posting text status: "${text}"`);
  await db.addLog('info', `Posting WhatsApp text status update: ${text}`);
  return await sendStatus('text', text);
}

/**
 * Posts a media status update (image) to WhatsApp Status.
 */
export async function sendStatusImage(localImagePath, caption = '') {
  console.log(`Posting image status from ${localImagePath} with caption: "${caption}"`);
  await db.addLog('info', `Posting WhatsApp image status from ${localImagePath}`);

  try {
    const fileData = await fs.readFile(localImagePath, 'base64');
    const base64Data = `data:image/png;base64,${fileData}`;
    
    return await sendStatus('image', base64Data, caption);
  } catch (err) {
    console.error('Failed to read local status image file:', err);
    await db.addLog('error', `Failed to post status image: ${err.message}`);
    return false;
  }
}
