// נהוראי - Public Leaderboard client logic. Talks ONLY to /api/public/* -
// no admin PIN, no access to admin-only data, by design (security boundary
// with the dashboard in app.js/index.html).

const POLL_INTERVAL_MS = 8000;
const VOTED_STORAGE_KEY = 'nehoraiVotedChatIds';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function getVotedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) || '[]'));
  } catch (_) {
    return new Set();
  }
}

function markVoted(chatId) {
  const set = getVotedSet();
  set.add(chatId);
  localStorage.setItem(VOTED_STORAGE_KEY, JSON.stringify([...set]));
}

// ---------- Status widget (night rest / weekend "vibe" phrases) ----------

const STATUS_PHRASES = {
  night: [
    '🔴 נהוראי הלך לקטלה (הודעות יענו בבוקר)',
    '🔴 נהוראי בישיבה עם האחים, אל תחפרו',
    '🔴 נהוראי בנהיגה על הטימקס, שחררו',
    '🔴 נהוראי עושה על האש, דברו איתו מחר'
  ],
  thursdayEvening: ['🔪 נהוראי בסטטוס: חמישי דוקר (בדרך למועדון, עונה בדיליי)'],
  friday: ['✋ נהוראי בסטטוס: שישי נודר (Weekend Chill פעיל, המכסה ירדה בחצי)'],
  saturday: ['🕯️ נהוראי בסטטוס: שבת שומר (ניתוק לוגיסטי מלא, הבוט ישן עד מוצ"ש)'],
  normal: ['🟢 נהוראי ער וזמין, תכתבו לו']
};

function pickStatusCategory(botStatus) {
  const { isNight, weekdayNum, hour } = botStatus;
  if (weekdayNum === 6) return 'saturday'; // Saturday
  if (weekdayNum === 5) return 'friday'; // Friday
  if (weekdayNum === 4 && hour >= 16) return 'thursdayEvening'; // Thursday from 16:00
  if (isNight) return 'night';
  return 'normal';
}

async function loadStatusWidget() {
  try {
    const res = await fetch('/api/public/config');
    const config = await res.json();
    window.__leaderboardTopics = config.topics || [];
    const category = pickStatusCategory(config.botStatus || {});
    const phrases = STATUS_PHRASES[category] || STATUS_PHRASES.normal;
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    document.getElementById('status-text').textContent = phrase;
    populateTopicSelect(window.__leaderboardTopics);
  } catch (err) {
    document.getElementById('status-text').textContent = '🟡 נהוראי איפשהו שם בחוץ';
  }
}

function populateTopicSelect(topics) {
  const select = document.getElementById('topic-select');
  select.innerHTML = (topics.length ? topics : ['סתם שיחת חולין'])
    .map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
    .join('');
}

// ---------- Decorative "live" telemetry ticker (NOT real logs - see plan) ----------

const TELEMETRY_LINES = [
  '⚡ המערכת מחשבת אורך קללה... משדרת ל-Meta מצב הקלדה (Composing State) של 2.4 שניות.',
  '🔵 נשלח סיגנל Mark Read – וי כחול טבעי הופעל בהצלחה.',
  '⏱️ אלגוריתם Busy Ghosting הופעל: מעכב תגובה ב-7 דקות כדי לא להיראות רובוטי.',
  '📡 מדמה מצב "מחובר" מול שרתי WhatsApp...',
  '🧠 מנוע השפה בוחר סלנג מותאם לשעה הזאת...'
];

let telemetryTimer = null;
function typeTelemetryLine(line) {
  const el = document.getElementById('telemetry-text');
  let i = 0;
  clearInterval(telemetryTimer);
  el.textContent = '';
  telemetryTimer = setInterval(() => {
    el.textContent = line.slice(0, i);
    i++;
    if (i > line.length) clearInterval(telemetryTimer);
  }, 22);
}

function startTelemetryLoop() {
  let idx = 0;
  typeTelemetryLine(TELEMETRY_LINES[idx]);
  setInterval(() => {
    idx = (idx + 1) % TELEMETRY_LINES.length;
    typeTelemetryLine(TELEMETRY_LINES[idx]);
  }, 4000);
}

// ---------- Leaderboard feed ----------

function renderBubbles(messages) {
  return messages.map(m => `
    <div class="chat-bubble ${m.isOutgoing ? 'outgoing' : 'incoming'}">${escapeHtml(m.text)}</div>
  `).join('');
}

function medalFor(rank) {
  return rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '';
}

function chairSvg() {
  return `<svg viewBox="0 0 24 24"><path d="M6 3h12v2H6V3zm0 4h12a2 2 0 0 1 2 2v3h-2v7h-2v-4H8v4H6v-7H4V9a2 2 0 0 1 2-2z"/></svg>`;
}

async function loadFeed() {
  try {
    const res = await fetch('/api/public/chats');
    const chats = await res.json();
    chats.sort((a, b) => b.voteCount - a.voteCount);
    renderFeed(chats);
  } catch (err) {
    // Keep whatever was already rendered; a transient poll failure isn't worth
    // wiping the visible feed.
    console.error('Failed to load leaderboard feed', err);
  }
}

function renderFeed(chats) {
  const grid = document.getElementById('chat-grid');
  if (chats.length === 0) {
    grid.innerHTML = '<div class="empty-feed">עוד אין צ\'אטים בלידרבורד - תהיה הראשון לדבר עם נהוראי!</div>';
    return;
  }
  const votedSet = getVotedSet();
  grid.innerHTML = chats.map((chat, idx) => `
    <div class="chat-card" data-chat-id="${escapeHtml(chat.id)}">
      <div class="chat-card-head">
        <span class="alias">${escapeHtml(chat.displayAlias)}</span>
        <span class="rank">${medalFor(idx)}</span>
      </div>
      <div class="phone-body">${renderBubbles(chat.messages)}</div>
      <div class="chat-card-foot">
        <span class="vote-count">${chat.voteCount} הצבעות</span>
        <button class="vote-btn" data-chat-id="${escapeHtml(chat.id)}" ${votedSet.has(chat.id) ? 'disabled' : ''}>
          ${chairSvg()}
          <span>${votedSet.has(chat.id) ? 'הצבעת!' : 'הצבע'}</span>
        </button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.vote-btn').forEach(btn => {
    btn.addEventListener('click', () => castVote(btn));
  });
}

function spawnConfetti(button) {
  const rect = button.getBoundingClientRect();
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 30;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--rot', `${Math.random() * 360}deg`);
    p.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
    p.style.top = `${rect.top + rect.height / 2 + window.scrollY}px`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 650);
  }
}

async function castVote(btn) {
  const chatId = btn.dataset.chatId;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('bounced');
  spawnConfetti(btn);

  try {
    const res = await fetch('/api/public/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    });
    if (res.ok) {
      markVoted(chatId);
      btn.querySelector('span').textContent = 'הצבעת!';
      loadFeed();
    } else {
      // Already voted (409) or some other rejection - reflect it as voted
      // either way since a retry can't succeed for this voter.
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) markVoted(chatId);
      btn.querySelector('span').textContent = data.error === undefined ? 'הצבעת!' : 'לא זמין';
    }
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('bounced');
  }
}

// ---------- Screen shake trigger (chair-throw moment near video end) ----------

function setupScreenShake() {
  const video = document.getElementById('hero-video');
  let shaken = false;
  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const remaining = video.duration - video.currentTime;
    if (!shaken && remaining < 0.6) {
      shaken = true;
      document.body.classList.add('shake');
      setTimeout(() => document.body.classList.remove('shake'), 500);
      const cta = document.getElementById('cta-signup-btn');
      cta.classList.add('pulse');
      setTimeout(() => cta.classList.remove('pulse'), 4200);
    }
  });
  video.addEventListener('seeked', () => {
    if (video.currentTime < 0.3) shaken = false;
  });
}

// ---------- Docs tabs ----------

function setupDocsTabs() {
  document.querySelectorAll('.docs-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.docs-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.docs-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`doc-${btn.dataset.doc}`).classList.add('active');
    });
  });
}

// ---------- Signup flow ----------

function setupSignupFlow() {
  const modal = document.getElementById('signup-modal');
  const stepGuide = document.getElementById('signup-step-guide');
  const stepForm = document.getElementById('signup-step-form');
  const consentCheckbox = document.getElementById('consent-checkbox');
  const continueBtn = document.getElementById('signup-continue');
  const submitBtn = document.getElementById('signup-submit');
  const errorEl = document.getElementById('signup-error');

  function openModal() {
    modal.classList.add('open');
    stepGuide.style.display = '';
    stepForm.style.display = 'none';
    consentCheckbox.checked = false;
    continueBtn.disabled = true;
    errorEl.textContent = '';
  }
  function closeModal() { modal.classList.remove('open'); }

  document.getElementById('cta-signup-btn').addEventListener('click', openModal);
  document.getElementById('signup-cancel-1').addEventListener('click', closeModal);
  document.getElementById('signup-back').addEventListener('click', () => {
    stepForm.style.display = 'none';
    stepGuide.style.display = '';
  });

  consentCheckbox.addEventListener('change', () => {
    continueBtn.disabled = !consentCheckbox.checked;
  });

  continueBtn.addEventListener('click', () => {
    if (!consentCheckbox.checked) return;
    stepGuide.style.display = 'none';
    stepForm.style.display = '';
  });

  submitBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const displayAlias = document.getElementById('alias-input').value.trim();
    const phone = document.getElementById('phone-input').value.trim();
    const topic = document.getElementById('topic-select').value;
    const website = document.getElementById('website-honeypot').value;

    if (!displayAlias) {
      errorEl.textContent = 'צריך למלא שם תצוגה';
      return;
    }
    if (!phone) {
      errorEl.textContent = 'צריך למלא מספר טלפון';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'רגע...';
    try {
      const res = await fetch('/api/public/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayAlias, phone, topic, consentAccepted: true, website })
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'משהו השתבש, נסה שוב';
        submitBtn.disabled = false;
        submitBtn.textContent = 'קדימה, תפתח לי וואטסאפ';
        return;
      }
      window.location.href = data.waLink;
    } catch (err) {
      errorEl.textContent = 'משהו השתבש, נסה שוב';
      submitBtn.disabled = false;
      submitBtn.textContent = 'קדימה, תפתח לי וואטסאפ';
    }
  });
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', () => {
  loadStatusWidget();
  startTelemetryLoop();
  loadFeed();
  setInterval(loadFeed, POLL_INTERVAL_MS);
  setupScreenShake();
  setupDocsTabs();
  setupSignupFlow();
});
