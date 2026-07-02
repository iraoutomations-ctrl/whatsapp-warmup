// API Helper Functions
async function fetchAPI(endpoint, options = {}) {
  try {
    const response = await fetch(endpoint, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`API Call failed to ${endpoint}:`, error);
    showNotification(error.message, 'error');
    throw error;
  }
}

// Global State
let contactsList = [];
let logsList = [];
let systemStatus = {};
let simulatorHistory = [];
let activeChatPhone = null;

// DOM Elements
const systemStatusPill = document.getElementById('system-status-pill');
const nightStatusPill = document.getElementById('night-status-pill');
const weekendStatusPill = document.getElementById('weekend-status-pill');

const warmupDayVal = document.getElementById('warmup-day-val');
const warmupPhaseVal = document.getElementById('warmup-phase-val');
const warmupProgressBar = document.getElementById('warmup-progress-bar');

const quotaVal = document.getElementById('quota-val');
const quotaPercent = document.getElementById('quota-percent');
const quotaProgressBar = document.getElementById('quota-progress-bar');

const statIncoming = document.getElementById('stat-incoming');
const statOutgoing = document.getElementById('stat-outgoing');
const statGroup = document.getElementById('stat-group');
const statusTodayVal = document.getElementById('status-today-val');
const btnPostStatus = document.getElementById('btn-post-status');
const statusPreviewContainer = document.getElementById('status-preview-container');
const statusPreviewVal = document.getElementById('status-preview-val');
const btnTestConnection = document.getElementById('btn-test-connection');
const connectionTestResults = document.getElementById('connection-test-results');

const logsListContainer = document.getElementById('logs-list');
const contactsTableBody = document.getElementById('contacts-table-body');
const simContactSelect = document.getElementById('sim-contact-select');

// Modals & Forms
const addContactModal = document.getElementById('add-contact-modal');
const openAddContactModalBtn = document.getElementById('btn-open-add-contact-modal');
const closeContactModalBtn = document.getElementById('btn-close-contact-modal');
const cancelContactModalBtn = document.getElementById('btn-cancel-contact-modal');
const addContactForm = document.getElementById('add-contact-form');
const settingsForm = document.getElementById('settings-form');
const simulatorForm = document.getElementById('simulator-form');

// Simulator Specific DOM
const phoneChatName = document.getElementById('phone-chat-name');
const phoneChatStatus = document.getElementById('phone-chat-status');
const phoneChatHistory = document.getElementById('phone-chat-history');

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  loadData();
  
  // Start Polling Stats & Logs every 5 seconds for real-time dashboard updates
  setInterval(pollRealtimeData, 5000);

  // Setup Event Listeners
  openAddContactModalBtn.addEventListener('click', () => addContactModal.classList.add('open'));
  closeContactModalBtn.addEventListener('click', () => addContactModal.classList.remove('open'));
  cancelContactModalBtn.addEventListener('click', () => addContactModal.classList.remove('open'));
  addContactForm.addEventListener('submit', handleAddContact);
  settingsForm.addEventListener('submit', handleSaveSettings);
  simulatorForm.addEventListener('submit', handleSimulatorSubmit);
  btnPostStatus.addEventListener('click', handlePostStatus);
  btnTestConnection.addEventListener('click', handleTestConnection);
  
  const btnResetData = document.getElementById('btn-reset-data');
  if (btnResetData) {
    btnResetData.addEventListener('click', handleResetData);
  }
  
  const liveChatForm = document.getElementById('livechat-send-form');
  if (liveChatForm) {
    liveChatForm.addEventListener('submit', handleLiveChatSend);
  }
  
  document.getElementById('btn-clear-logs-ui').addEventListener('click', () => {
    logsListContainer.innerHTML = '<div class="empty-state">תצוגה נוקתה. לוגים חדשים יופיעו בהמשך.</div>';
  });
  
  // Custom simulator dropdown handler
  simContactSelect.addEventListener('change', (e) => {
    const selectedPhone = e.target.value;
    if (selectedPhone) {
      const contact = contactsList.find(c => c.phone === selectedPhone);
      if (contact) {
        document.getElementById('sim-sender-name').value = contact.name;
        document.getElementById('sim-phone').value = contact.phone;
        phoneChatName.textContent = contact.name;
      }
    }
  });
});

// Setup Navigation Tabs
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabId = button.getAttribute('data-tab');
      
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      
      button.classList.add('active');
      document.getElementById(`tab-${tabId}`).classList.add('active');

      // Apply full-height mode when livechat tab is active
      if (tabId === 'livechat') {
        document.body.classList.add('livechat-mode');
      } else {
        document.body.classList.remove('livechat-mode');
      }
    });
  });
}

// Load status, contacts, and logs
async function loadData() {
  await Promise.all([
    fetchStatus(),
    fetchContacts(),
    fetchLogs()
  ]);
  updateLiveChatUI();
}

// Staggered Polling
async function pollRealtimeData() {
  try {
    await fetchStatus();
    await fetchLogs();
    updateLiveChatUI();
  } catch (err) {
    console.error('Polling failed:', err);
  }
}

// API fetches
async function fetchStatus() {
  const status = await fetchAPI('/api/status');
  systemStatus = status;
  updateStatusUI();
}

async function fetchContacts() {
  const contacts = await fetchAPI('/api/contacts');
  contactsList = contacts;
  updateContactsUI();
  updateSimulatorDropdown();
}

async function fetchLogs() {
  const logs = await fetchAPI('/api/logs');
  logsList = logs;
  updateLogsUI();
}

// Update Status indicators and stats
function updateStatusUI() {
  const config = systemStatus.config;
  const stats = systemStatus.stats;
  const isNight = systemStatus.isNight;
  
  // 1. Status Pill
  const dot = systemStatusPill.querySelector('.dot');
  const label = systemStatusPill.querySelector('.label');
  
  if (config.warmupEnabled) {
    if (isNight) {
      dot.className = 'dot pulse orange';
      label.textContent = 'פעיל (מנוחת לילה)';
    } else {
      dot.className = 'dot pulse green';
      label.textContent = 'חימום פעיל';
    }
  } else {
    dot.className = 'dot pulse gray';
    label.textContent = 'מערכת כבויה';
  }

  // 2. Night Pill
  nightStatusPill.querySelector('.label').textContent = `מצב לילה: ${isNight ? 'פעיל 🌙' : 'כבוי'}`;
  if (isNight) {
    nightStatusPill.classList.add('active');
  } else {
    nightStatusPill.classList.remove('active');
  }

  // 3. Weekend Pill
  const isWk = stats.quota < config.week1Limit && config.currentDay <= 7 || stats.quota < config.week2Limit && config.currentDay > 7;
  weekendStatusPill.querySelector('.label').textContent = `סופ"ש (שבתון): ${isWk ? 'פעיל 🌴' : 'כבוי'}`;

  // 4. Warmup Day Progress Card
  warmupDayVal.textContent = `${config.currentDay} / 14`;
  const phase = config.currentDay <= 7 ? 'שלב 1 (בניית בסיס)' : 'שלב 2 (הגברת קצב)';
  warmupPhaseVal.textContent = phase;
  const progressPercent = Math.min((config.currentDay / 14) * 100, 100);
  warmupProgressBar.style.width = `${progressPercent}%`;

  // 5. Daily Quota Progress Card
  quotaVal.textContent = `${stats.outgoing} / ${stats.quota}`;
  const quotaPercentVal = stats.quota > 0 ? Math.min((stats.outgoing / stats.quota) * 100, 100) : 0;
  quotaPercent.textContent = `${Math.round(quotaPercentVal)}%`;
  quotaProgressBar.style.width = `${quotaPercentVal}%`;

  // 6. Mini stats
  statIncoming.textContent = stats.incoming;
  statOutgoing.textContent = stats.outgoing;
  statGroup.textContent = stats.group;

  // 6.5. WhatsApp Status Story
  const todayDateStr = stats.todayDate;
  const statusImagePreviewBox = document.getElementById('status-image-preview-box');
  const statusPreviewImg = document.getElementById('status-preview-img');

  if (config.lastStatusPostDate === todayDateStr) {
    statusTodayVal.textContent = 'פורסם היום ✅';
    statusTodayVal.style.color = '#34d399';
    
    // Show preview container and format the text nicely
    statusPreviewContainer.style.display = 'block';
    if (config.lastStatusPostType === 'image') {
      statusPreviewVal.textContent = `"${config.lastStatusPostCaption || ''}"`;
      statusImagePreviewBox.style.display = 'block';
      statusPreviewImg.src = `/assets/status_images/${config.lastStatusPostFile}`;
    } else if (config.lastStatusPostType === 'text') {
      statusPreviewVal.textContent = `"${config.lastStatusPostText || ''}"`;
      statusImagePreviewBox.style.display = 'none';
      statusPreviewImg.src = '';
    } else {
      statusPreviewVal.textContent = 'הסטטוס היומי שודר בהצלחה!';
      statusImagePreviewBox.style.display = 'none';
      statusPreviewImg.src = '';
    }
  } else {
    statusTodayVal.textContent = 'לא פורסם ❌';
    statusTodayVal.style.color = '#f87171';
    statusPreviewContainer.style.display = 'none';
    statusImagePreviewBox.style.display = 'none';
    statusPreviewImg.src = '';
  }

  // 7. Populating form elements with config settings (only if form isn't dirty/being edited)
  if (!settingsForm.classList.contains('dirty')) {
    document.getElementById('setting-gemini-key').value = config.geminiApiKey || '';
    document.getElementById('setting-evo-url').value = config.evolutionUrl || '';
    document.getElementById('setting-evo-token').value = config.evolutionToken || '';
    document.getElementById('setting-evo-instance').value = config.evolutionInstance || '';
    
    document.getElementById('setting-current-day').value = config.currentDay;
    document.getElementById('setting-warmup-enabled').checked = config.warmupEnabled;
    document.getElementById('setting-rest-start').value = config.nightRestStart;
    document.getElementById('setting-rest-end').value = config.nightRestEnd;
    document.getElementById('setting-night-rest-enabled').checked = config.nightRestEnabled !== false;
    document.getElementById('setting-busy-simulation-enabled').checked = config.busySimulationEnabled !== false;
    document.getElementById('setting-interval-min').value = config.activeMinIntervalMinutes;
    document.getElementById('setting-interval-max').value = config.activeMaxIntervalMinutes;
    
    document.getElementById('setting-limit-w1').value = config.week1Limit;
    document.getElementById('setting-limit-w2').value = config.week2Limit;
    
    document.getElementById('setting-groups-enabled').checked = config.groupsEnabled;
    document.getElementById('setting-group-limit').value = config.groupReplyLimitPerDay;
  }
}

// Mark settings form as dirty when user edits config input fields
document.querySelectorAll('#settings-form input, #settings-form select').forEach(input => {
  input.addEventListener('input', () => {
    settingsForm.classList.add('dirty');
  });
});

// Update Logs View
function updateLogsUI() {
  if (logsList.length === 0) {
    logsListContainer.innerHTML = '<div class="empty-state">אין לוגים להצגה כרגע.</div>';
    return;
  }

  logsListContainer.innerHTML = '';
  logsList.forEach(log => {
    const logItem = document.createElement('div');
    logItem.className = `log-item ${log.type}`;
    
    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    
    let detailsHtml = `<strong>[${log.type.toUpperCase()}]</strong> ${log.details}`;
    if (log.message) {
      detailsHtml += `<span class="log-text-msg">${log.message}</span>`;
    }
    
    logItem.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-content">${detailsHtml}</span>
    `;
    
    logsListContainer.appendChild(logItem);
  });
}

// Update Guided Contacts List View
function updateContactsUI() {
  if (contactsList.length === 0) {
    contactsTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted italic">טרם הוגדרו אנשי קשר מודרכים.</td>
      </tr>
    `;
    return;
  }

  contactsTableBody.innerHTML = '';
  contactsList.forEach(contact => {
    const tr = document.createElement('tr');
    
    const lastActive = contact.lastInteractionAt 
      ? new Date(contact.lastInteractionAt).toLocaleString() 
      : 'ללא פעילות';
      
    tr.innerHTML = `
      <td><strong>${contact.name}</strong></td>
      <td>${contact.phone}</td>
      <td class="text-muted">${contact.notes || '-'}</td>
      <td>${contact.messageCount}</td>
      <td><small>${lastActive}</small></td>
      <td>
        <label class="toggle-switch">
          <input type="checkbox" ${contact.enabled ? 'checked' : ''} onchange="toggleContact('${contact.phone}', this.checked)">
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <div class="actions-cell">
          <button class="btn btn-sm btn-outline" onclick="triggerStarter('${contact.phone}')" title="שלח הודעה יזומה מידית">Initiate ⚡</button>
          <button class="btn btn-sm btn-outline" style="border-color: rgba(239, 68, 68, 0.3); color: #fca5a5" onclick="deleteContact('${contact.phone}')" title="מחק">מחק 🗑️</button>
        </div>
      </td>
    `;
    
    contactsTableBody.appendChild(tr);
  });
}

// Update Simulator Contact select list
function updateSimulatorDropdown() {
  // Save current selection JID
  const currentSelected = simContactSelect.value;
  
  simContactSelect.innerHTML = '<option value="">-- בחר איש קשר מודרך --</option>';
  
  contactsList.forEach(contact => {
    const option = document.createElement('option');
    option.value = contact.phone;
    option.textContent = `${contact.name} (${contact.phone})`;
    simContactSelect.appendChild(option);
  });
  
  // Re-select
  if (currentSelected) {
    simContactSelect.value = currentSelected;
  }
}

// Form Handlers
async function handleAddContact(e) {
  e.preventDefault();
  
  const payload = {
    name: document.getElementById('contact-name').value,
    phone: document.getElementById('contact-phone').value,
    notes: document.getElementById('contact-notes').value,
    enabled: document.getElementById('contact-enabled').checked
  };
  
  try {
    const result = await fetchAPI('/api/contacts', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    
    if (result.success) {
      showNotification(`איש הקשר ${payload.name} נוסף בהצלחה!`, 'success');
      addContactForm.reset();
      addContactModal.classList.remove('open');
      await fetchContacts();
    }
  } catch (err) {
    // Already handled by fetchAPI
  }
}

async function handleSaveSettings(e) {
  e.preventDefault();
  
  const payload = {
    geminiApiKey: document.getElementById('setting-gemini-key').value,
    evolutionUrl: document.getElementById('setting-evo-url').value,
    evolutionToken: document.getElementById('setting-evo-token').value,
    evolutionInstance: document.getElementById('setting-evo-instance').value,
    
    currentDay: parseInt(document.getElementById('setting-current-day').value),
    warmupEnabled: document.getElementById('setting-warmup-enabled').checked,
    nightRestStart: document.getElementById('setting-rest-start').value,
    nightRestEnd: document.getElementById('setting-rest-end').value,
    nightRestEnabled: document.getElementById('setting-night-rest-enabled').checked,
    busySimulationEnabled: document.getElementById('setting-busy-simulation-enabled').checked,
    activeMinIntervalMinutes: parseInt(document.getElementById('setting-interval-min').value),
    activeMaxIntervalMinutes: parseInt(document.getElementById('setting-interval-max').value),
    
    week1Limit: parseInt(document.getElementById('setting-limit-w1').value),
    week2Limit: parseInt(document.getElementById('setting-limit-w2').value),
    
    groupsEnabled: document.getElementById('setting-groups-enabled').checked,
    groupReplyLimitPerDay: parseInt(document.getElementById('setting-group-limit').value)
  };
  
  try {
    const result = await fetchAPI('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    
    if (result.success) {
      showNotification('ההגדרות נשמרו ועודכנו במערכת!', 'success');
      settingsForm.classList.remove('dirty');
      await fetchStatus();
    }
  } catch (err) {
    // Already handled
  }
}

// Toggle enabled status
window.toggleContact = async function(phone, enabled) {
  try {
    await fetchAPI(`/api/contacts/${phone}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    });
    showNotification(`סטטוס איש קשר עודכן`, 'success');
    await fetchContacts();
  } catch (err) {
    // Restore checkbox state
    await fetchContacts();
  }
};

// Delete a contact
window.deleteContact = async function(phone) {
  if (!confirm('האם אתה בטוח שברצונך למחוק איש קשר מודרך זה?')) return;
  
  try {
    await fetchAPI(`/api/contacts/${phone}`, {
      method: 'DELETE'
    });
    showNotification('איש הקשר נמחק מהמערכת', 'success');
    await fetchContacts();
  } catch (err) {
    // Handled
  }
};

// Manually trigger conversation starter
window.triggerStarter = async function(phone) {
  showNotification('מחולל פנייה יזומה מול ג\'ימיני...', 'info');
  try {
    const result = await fetchAPI('/api/test/starter', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    
    if (result.success) {
      showNotification(`הודעת פתיחה נשלחה: ${result.message}`, 'success');
      await pollRealtimeData();
    }
  } catch (err) {
    // Handled
  }
};

// Handle simulator message submission
async function handleSimulatorSubmit(e) {
  e.preventDefault();
  
  const phone = document.getElementById('sim-phone').value || '972500000000';
  const name = document.getElementById('sim-sender-name').value || 'שולח סימולטיבי';
  const message = document.getElementById('sim-message').value;
  const isGroup = document.getElementById('sim-is-group').checked;
  
  if (!message) return;
  
  phoneChatName.textContent = isGroup ? `קבוצה: ${name}` : name;
  
  // 1. Render incoming message on phone simulator immediately
  appendSimulatorMessage(name, message, 'incoming');
  document.getElementById('sim-message').value = ''; // clear input
  
  // Scroll to bottom
  phoneChatHistory.scrollTop = phoneChatHistory.scrollHeight;

  // 2. Show typing indicator to simulate waiting for bot response
  const typingBubble = showSimulatorTypingIndicator();
  
  try {
    const result = await fetchAPI('/api/test/incoming', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        message,
        isGroup,
        senderName: name
      })
    });

    // Remove typing bubble
    typingBubble.remove();
    
    // Stagger slightly and read logs to find the response generated by the bot
    setTimeout(async () => {
      await pollRealtimeData();
      
      // Look for the latest log message that is outgoing and matching this phone number JID
      const latestLogs = logsList.filter(log => log.phone === phone.split('@')[0] && log.isOutgoing);
      
      if (latestLogs.length > 0) {
        const botReply = latestLogs[0].message;
        appendSimulatorMessage('שריון אמינות (בוט)', botReply, 'outgoing');
      } else {
        // Look if it's queued or ignored
        const latestInfoLog = logsList[0];
        if (latestInfoLog && latestInfoLog.details.includes('Queued')) {
          appendSimulatorMessage('מערכת', '💤 ההודעה התקבלה בלילה וצורפה לתור המענה של הבוקר.', 'system');
        } else {
          appendSimulatorMessage('מערכת', 'ℹ️ ההודעה התקבלה אך שרת הבוט בחר להתעלם ממנה (ייתכן שאינו בקבוצת החימום או שהמערכת כבויה).', 'system');
        }
      }
      phoneChatHistory.scrollTop = phoneChatHistory.scrollHeight;
    }, 1500);

  } catch (err) {
    typingBubble.remove();
    appendSimulatorMessage('שגיאה', 'משהו השתבש בעיבוד הודעת הסימולטור.', 'system');
  }
}

// Append chat bubbles to phone screen
function appendSimulatorMessage(sender, text, direction) {
  if (direction === 'system') {
    const div = document.createElement('div');
    div.className = 'system-bubble';
    div.textContent = text;
    phoneChatHistory.appendChild(div);
    return;
  }
  
  const div = document.createElement('div');
  div.className = `chat-bubble ${direction}`;
  
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  div.innerHTML = `
    <span class="msg-sender">${sender}</span>
    <span class="msg-text">${text}</span>
    <span class="msg-time">${timeStr}</span>
  `;
  
  phoneChatHistory.appendChild(div);
}

// Show active typing bubble on phone simulator
function showSimulatorTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'typing-bubble';
  div.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;
  phoneChatHistory.appendChild(div);
  phoneChatHistory.scrollTop = phoneChatHistory.scrollHeight;
  return div;
}

// Toast Notifications helper
function showNotification(message, type = 'info') {
  // Create toast element
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  // Custom toast styling dynamically added
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '20px',
    left: '20px',
    padding: '12px 24px',
    borderRadius: '10px',
    backgroundColor: type === 'error' ? 'rgba(239, 68, 68, 0.9)' : type === 'success' ? 'rgba(16, 185, 129, 0.9)' : 'rgba(139, 92, 246, 0.9)',
    color: '#fff',
    fontSize: '0.9rem',
    fontWeight: '500',
    boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
    zIndex: '1000',
    transition: 'all 0.3s ease',
    opacity: '0',
    transform: 'translateY(20px)',
    direction: 'rtl'
  });
  
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 50);
  
  // Dismiss after 4 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

async function handlePostStatus() {
  btnPostStatus.disabled = true;
  btnPostStatus.textContent = 'מפרסם סטטוס... ⏳';
  
  try {
    const data = await fetchAPI('/api/status/trigger', { method: 'POST' });
    if (data.success) {
      if (data.result.type === 'image') {
        showNotification(`הסטטוס פורסם בהצלחה! תמונה עם כיתוב: "${data.result.caption}"`, 'success');
      } else {
        showNotification(`הסטטוס פורסם בהצלחה! טקסט: "${data.result.text}"`, 'success');
      }
      await loadData(); // Refresh logs and stats
    }
  } catch (err) {
    console.error('Manual status trigger failed:', err);
    showNotification(`פרסום הסטטוס נכשל: ${err.message}`, 'error');
  } finally {
    btnPostStatus.disabled = false;
    btnPostStatus.textContent = 'פרסם סטטוס עכשיו 📢';
  }
}

async function handleTestConnection() {
  btnTestConnection.disabled = true;
  btnTestConnection.textContent = 'בודק חיבורים... ⏳';
  connectionTestResults.style.display = 'block';
  connectionTestResults.style.border = '1px solid rgba(255,255,255,0.1)';
  connectionTestResults.innerHTML = '<span style="color: var(--text-secondary);">מבצע בדיקה של מפתח Gemini וחיבור ה-Evolution API, אנא המתן...</span>';
  
  try {
    const res = await fetchAPI('/api/test-connection');
    
    let html = '';
    
    // Gemini Status
    if (res.report.gemini.success) {
      html += '<div style="margin-bottom: 8px;"><strong style="color: #34d399;">✅ Gemini API:</strong> מחובר ותקין! מפתח ה-API של Studio מאומת.</div>';
    } else {
      html += `<div style="margin-bottom: 8px;"><strong style="color: #f87171;">❌ Gemini API:</strong> שגיאה!<br><span style="font-size: 0.8rem; color: #f87171;">${res.report.gemini.error}</span></div>`;
    }
    
    // Evolution Status
    if (res.report.evolution.success) {
      html += `<div><strong style="color: #34d399;">✅ Evolution API:</strong> מחובר ותקין!<br>מכשיר הוואטסאפ במצב מחובר (Instance State: <strong>${res.report.evolution.state}</strong>).</div>`;
    } else {
      const stateColor = res.report.evolution.state === 'close' ? '#fbbf24' : '#f87171';
      const headingText = res.report.evolution.state === 'close' ? 'בעיית התחברות (WhatsApp offline)' : 'בעיה בחיבור';
      html += `<div><strong style="color: ${stateColor};">❌ Evolution API (${headingText}):</strong><br><span style="font-size: 0.8rem; color: #f87171;">${res.report.evolution.error || 'נכשל בפנייה לשרת'}</span></div>`;
    }
    
    connectionTestResults.innerHTML = html;
    
    if (res.success) {
      showNotification('בדיקת ההתממשקות עברה בהצלחה מלאה! כל הצינורות תקינים.', 'success');
    } else {
      showNotification('נמצאו שגיאות בחיבור. אנא בדוק את הפרטים שהזנת.', 'error');
    }
  } catch (err) {
    console.error('Connection test failed:', err);
    connectionTestResults.innerHTML = `<span style="color: #f87171;">שגיאה קריטית בביצוע הבדיקה: ${err.message}</span>`;
    showNotification(`הבדיקה נכשלה: ${err.message}`, 'error');
  } finally {
    btnTestConnection.disabled = false;
    btnTestConnection.textContent = '🔍 בדיקת התממשקות וחיבור API';
  }
}

async function handleResetData() {
  const btnResetData = document.getElementById('btn-reset-data');
  if (!confirm('האם אתה בטוח שברצונך לאפס את כל הלוגים, הסטטיסטיקות ותורי ההודעות? פעולה זו תנקה את לוח הבקרה לחלוטין (אך תשמור על הגדרות אנשי הקשר שלך).')) {
    return;
  }
  
  try {
    btnResetData.disabled = true;
    btnResetData.textContent = 'מאפס נתונים... ⏳';
    
    const result = await fetchAPI('/api/reset', { method: 'POST' });
    if (result.success) {
      showNotification('כל הנתונים, הסטטיסטיקות והתורים אופסו בהצלחה!', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } else {
      showNotification('איפוס הנתונים נכשל.', 'error');
    }
  } catch (err) {
    console.error('Data reset failed:', err);
    showNotification(`שגיאה באיפוס הנתונים: ${err.message}`, 'error');
  } finally {
    if (btnResetData) {
      btnResetData.disabled = false;
      btnResetData.textContent = 'אפס נתוני מערכת 🧹';
    }
  }
}

// Update the split-pane Live Chat UI
function updateLiveChatUI() {
  const sidebarContainer = document.getElementById('livechat-list');
  if (!sidebarContainer) return;

  const delayedReplies = systemStatus.delayedReplies || [];
  const nightQueue = systemStatus.nightQueue || [];

  // Sort contacts by last interaction (most recent first)
  const contacts = [...contactsList].sort((a, b) => {
    const timeA = a.lastInteractionAt ? new Date(a.lastInteractionAt).getTime() : 0;
    const timeB = b.lastInteractionAt ? new Date(b.lastInteractionAt).getTime() : 0;
    if (timeA !== timeB) return timeB - timeA;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (contacts.length === 0) {
    sidebarContainer.innerHTML = '<div class="empty-state">אין אנשי קשר מוגדרים.</div>';
    return;
  }

  let html = '';
  contacts.forEach(contact => {
    // 1. Determine status badge
    let statusBadge = '<span class="badge badge-green">חופשי 🟢</span>';
    const isDelayed = delayedReplies.find(r => r.phone === contact.phone);
    const isNightQueued = nightQueue.find(q => q.phone === contact.phone);

    if (isDelayed) {
      statusBadge = '<span class="badge badge-violet">עסוק ⏳</span>';
    } else if (isNightQueued) {
      statusBadge = '<span class="badge badge-gray">במנוחה 🌙</span>';
    } else if (!contact.enabled) {
      statusBadge = '<span class="badge badge-gray">כבוי ❌</span>';
    }

    // 2. Find last message preview
    const contactLogs = logsList.filter(log => log.phone === contact.phone && log.type === 'message');
    let lastMsgPreview = contact.notes || 'אין הערות שיחה';
    let lastMsgTime = '';
    
    if (contactLogs.length > 0) {
      const lastLog = contactLogs[0]; // logsList is reverse-sorted, so index 0 is the latest!
      lastMsgPreview = lastLog.message || '';
      if (lastLog.timestamp) {
        lastMsgTime = new Date(lastLog.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      }
    }

    const isActive = activeChatPhone === contact.phone ? 'active' : '';
    const initials = contact.name ? contact.name.trim().substring(0, 2) : 'U';

    html += `
      <div class="chat-item ${isActive}" data-phone="${contact.phone}">
        <div class="chat-item-avatar">${initials}</div>
        <div class="chat-item-info">
          <div class="chat-item-name-row">
            <span class="chat-item-name">${contact.name}</span>
            <span class="chat-item-time">${lastMsgTime}</span>
          </div>
          <span class="chat-item-preview">${lastMsgPreview}</span>
          <div class="chat-item-status-row">
            ${statusBadge}
          </div>
        </div>
      </div>
    `;
  });

  sidebarContainer.innerHTML = html;

  // Add click listeners to chat items
  const chatItems = sidebarContainer.querySelectorAll('.chat-item');
  chatItems.forEach(item => {
    item.addEventListener('click', () => {
      activeChatPhone = item.getAttribute('data-phone');
      // Highlight active
      chatItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const messagesContainer = document.getElementById('livechat-messages-container');
      if (messagesContainer) {
        messagesContainer.setAttribute('data-just-opened', 'true');
      }
      renderActiveChat();
    });
  });

  // Keep the active conversation view updated in real-time as well
  renderActiveChat();
}

// Render the active chat conversation message list and info header
function renderActiveChat() {
  const emptyState = document.getElementById('livechat-empty-state');
  const activeWrapper = document.getElementById('livechat-active-wrapper');
  if (!emptyState || !activeWrapper) return;

  if (!activeChatPhone) {
    emptyState.style.display = 'flex';
    activeWrapper.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  activeWrapper.style.display = 'grid';

  const contact = contactsList.find(c => c.phone === activeChatPhone);
  if (!contact) return;

  // Header Details
  document.getElementById('livechat-avatar').textContent = contact.name ? contact.name.trim().substring(0, 2) : 'U';
  document.getElementById('livechat-contact-name').textContent = contact.name;
  document.getElementById('livechat-contact-phone').textContent = `+${contact.phone}`;
  document.getElementById('livechat-contact-notes').textContent = `נושא: ${contact.notes || 'כללי'}`;

  // Live status badge in header
  const statusBadge = document.getElementById('livechat-contact-status');
  const delayedReplies = systemStatus.delayedReplies || [];
  const nightQueue = systemStatus.nightQueue || [];
  const isDelayed = delayedReplies.find(r => r.phone === contact.phone);
  const isNightQueued = nightQueue.find(q => q.phone === contact.phone);

  if (isDelayed) {
    const minLeft = Math.ceil((new Date(isDelayed.sendAfter) - Date.now()) / 60000);
    statusBadge.className = 'badge badge-violet';
    statusBadge.textContent = minLeft > 0 ? `עסוק ⏳ (עונה בעוד ${minLeft} דק')` : 'עסוק ⏳';
  } else if (isNightQueued) {
    statusBadge.className = 'badge badge-gray';
    statusBadge.textContent = 'ממתין לבוקר 🌙';
  } else if (!contact.enabled) {
    statusBadge.className = 'badge badge-gray';
    statusBadge.textContent = 'מערכת כבויה ❌';
  } else {
    statusBadge.className = 'badge badge-green';
    statusBadge.textContent = 'חופשי 🟢';
  }

  // Filter and sort conversation logs (oldest first for chronological order)
  const conversationLogs = logsList
    .filter(log => log.phone === activeChatPhone && log.type === 'message')
    .slice() // copy to avoid mutating original
    .reverse(); // reverse oldest-first

  const messagesContainer = document.getElementById('livechat-messages-container');
  if (conversationLogs.length === 0) {
    messagesContainer.innerHTML = '<div class="system-bubble">אין הודעות קודמות. שלח הודעה כדי להתחיל שיחה!</div>';
    return;
  }

  let html = '';
  conversationLogs.forEach(log => {
    const isOutgoing = log.isOutgoing === true;
    const bubbleClass = isOutgoing ? 'outgoing' : 'incoming';
    const timeStr = log.timestamp 
      ? new Date(log.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
      : '';

    // Handle bubble splitting representation in the chat view
    const messageParts = (log.message || '').split('||');
    
    messageParts.forEach((part, index) => {
      const cleanPart = part.trim();
      if (!cleanPart) return;

      html += `
        <div class="chat-bubble ${bubbleClass}">
          ${!isOutgoing && index === 0 ? `<span class="msg-sender">${contact.name}</span>` : ''}
          <div class="msg-text">${cleanPart}</div>
          <span class="msg-time">${timeStr}</span>
        </div>
      `;
    });
  });

  // Save current scroll position, only scroll to bottom if user is close to bottom
  const wasAtBottom = messagesContainer.scrollHeight - messagesContainer.clientHeight - messagesContainer.scrollTop < 60;
  
  messagesContainer.innerHTML = html;

  if (wasAtBottom || messagesContainer.innerHTML.includes('system-bubble') || messagesContainer.getAttribute('data-just-opened') === 'true') {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    messagesContainer.removeAttribute('data-just-opened');
  }
}

// Submit handler to send a manual message from Live Chat
async function handleLiveChatSend(e) {
  e.preventDefault();
  const input = document.getElementById('livechat-input');
  if (!input) return;

  const message = input.value.trim();
  if (!message || !activeChatPhone) return;

  const sendBtn = document.getElementById('livechat-send-btn');
  try {
    input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    const res = await fetchAPI('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({
        phone: activeChatPhone,
        message: message
      })
    });

    if (res.success) {
      input.value = '';
      
      // Inject the manual message directly to local logsList to prevent lag
      const tempLog = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toISOString(),
        type: 'message',
        details: 'Sent manual message',
        message: message,
        phone: activeChatPhone,
        isOutgoing: true
      };
      
      logsList.unshift(tempLog); // add to top of cache
      
      // Force scroll to bottom by setting flag
      const messagesContainer = document.getElementById('livechat-messages-container');
      if (messagesContainer) {
        messagesContainer.setAttribute('data-just-opened', 'true');
      }

      showNotification('ההודעה נשלחה בהצלחה!', 'success');
      
      // Instantly refresh UI
      updateLiveChatUI();
      
      // Fetch status in background to update queues
      fetchStatus();
    }
  } catch (err) {
    console.error('Failed to send manual message:', err);
    showNotification('שגיאה בשליחת הודעה: ' + err.message, 'error');
  } finally {
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

// Global error tracking
window.__jsErrors = [];
window.onerror = function(message, source, lineno, colno, error) {
  const errStr = `${message} (line ${lineno})`;
  if (!window.__jsErrors.includes(errStr)) {
    window.__jsErrors.push(errStr);
  }
  return false;
};
