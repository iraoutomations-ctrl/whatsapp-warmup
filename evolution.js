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
      body: body ? JSON.stringify(body) : undefined
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

  const isGroup = number.endsWith('@g.us');
  const cleanNumber = isGroup ? number : number.split('@')[0];
  
  if (simulateTyping) {
    // Determine typing delay based on message length (approx. 50ms per character, min 2s, max 6s)
    const delay = Math.min(Math.max(text.length * 50, 2000), 6000);
    await sendTypingState(cleanNumber, 'composing', delay);
  }

  console.log(`Sending message to ${cleanNumber}: "${text}"`);

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
      text: text
    },
    // Adding standard fallback keys for different Evolution versions
    text: text
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
      reaction: {
        text: emoji
      }
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
    mediaType: mediaType,
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
 * Posts a text status update to WhatsApp Status.
 */
export async function sendStatusText(text) {
  console.log(`Posting text status: "${text}"`);
  await db.addLog('info', `Posting WhatsApp text status update: ${text}`);
  
  // To post status, we send a text message to "status@broadcast" JID.
  return await sendMessage('status@broadcast', text, false);
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
    
    return await sendMedia('status@broadcast', base64Data, 'image', 'status.png', caption);
  } catch (err) {
    console.error('Failed to read local status image file:', err);
    await db.addLog('error', `Failed to post status image: ${err.message}`);
    return false;
  }
}
