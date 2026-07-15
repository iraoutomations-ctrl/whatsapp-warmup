// נהוראי - Public Leaderboard client logic. Talks ONLY to /api/public/* -
// no admin PIN, no access to admin-only data, by design (security boundary
// with the dashboard in app.js/index.html).

const POLL_INTERVAL_MS = 8000;
const LIKED_STORAGE_KEY = 'nehoraiLikedChatIds';

let latestChats = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function getLikedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKED_STORAGE_KEY) || '[]'));
  } catch (_) {
    return new Set();
  }
}

function markLiked(chatId) {
  const set = getLikedSet();
  set.add(chatId);
  localStorage.setItem(LIKED_STORAGE_KEY, JSON.stringify([...set]));
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
  normal: [
    '🟢 נהוראי ער וזמין, תכתבו לו',
    '🟢 נהוראי משועמם, זה הזמן לתפוס אותו',
    '🟢 נהוראי פה, בואו נראה מי מעז'
  ]
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

// ---------- "Who's next" widget - DECORATIVE ONLY.
// Never wired to the real private scheduling data (nextActiveWarmupTargetName
// etc.) - that's a real, likely non-consenting contact's name. Only draws
// from displayAlias values already public on this exact page. ----------

const NEXT_TARGET_PHRASES = [
  alias => `👀 נהוראי מסתכל על ${alias} ומחליט אם בא לו לענות`,
  alias => `📤 יש סיכוי טוב ש-${alias} מקבל הודעה מנהוראי בקרוב`,
  alias => `🎯 נהוראי מתכנן לזרוק הודעה ל${alias} כל רגע`,
  () => `🔍 נהוראי סורק את הרשימה, מחפש על מי לזרוק כסא היום`
];

function updateNextTargetWidget() {
  const el = document.getElementById('next-target-text');
  if (!el) return;
  const aliases = latestChats.map(c => c.displayAlias).filter(Boolean);
  const phraseFn = NEXT_TARGET_PHRASES[Math.floor(Math.random() * NEXT_TARGET_PHRASES.length)];
  if (aliases.length === 0) {
    el.textContent = '🔍 נהוראי מחפש על מי לזרוק כסא היום';
    return;
  }
  const alias = aliases[Math.floor(Math.random() * aliases.length)];
  el.textContent = phraseFn(alias);
}

// ---------- Decorative "live" telemetry ticker (NOT real logs - see plan) ----------

const TELEMETRY_LINES = [
  '⚡ נהוראי מקליד יא באבא... מחשב אורך קללה מדויק.',
  '🔵 וי כחול טבעי הופעל, תירגע.',
  '⏱️ Busy Ghosting פעיל: נהוראי מתעכב בכוונה כדי לא להיראות רובוט.',
  '📡 נהוראי מחובר, מחפש על מי לזרוק כסא כתר.',
  '🚬 נהוראי הלך להביא קופסה מלברו רד, חוזר עוד שנייה.',
  '🧠 מנוע השפה בוחר סלנג שכונתי מותאם לשעה הזאת...'
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

function heartSvg() {
  return `<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.6 5 8 5 10 6.5 12 9c2-2.5 4-4 6.4-4C22 5 23.6 8.4 22 11.7 19.5 16.4 12 21 12 21z"/></svg>`;
}

// Live per-contact status, worded in Nehorai's voice - same wording used
// in the admin kill-switch table (app.js CONTACT_STATUS_BADGE).
const CONTACT_STATUS_LABEL = {
  typing: '⌨️ מקליד יא באבא...',
  quota_reached: '🔴 סגר איתו להיום',
  sleeping: '😴 ישן, יחזור בבוקר',
  delayed: '👻 מסנן אותו כרגע',
  ready: '🟢 פה וזמין, תכתוב מלך'
};

function renderChatCard(chat, rank, likedSet) {
  const statusLabel = CONTACT_STATUS_LABEL[chat.contactStatus] || CONTACT_STATUS_LABEL.ready;
  return `
    <div class="chat-card" data-chat-id="${escapeHtml(chat.id)}">
      <div class="chat-card-head">
        <span class="alias">${escapeHtml(chat.displayAlias)}</span>
        <span class="rank">${medalFor(rank)}</span>
      </div>
      <div class="chat-card-status">${statusLabel}</div>
      <div class="phone-body">${renderBubbles(chat.messages)}</div>
      <div class="chat-card-foot">
        <span class="vote-count">${chat.voteCount} לייקים</span>
        <button class="like-btn ${likedSet.has(chat.id) ? 'liked' : ''}" data-chat-id="${escapeHtml(chat.id)}" ${likedSet.has(chat.id) ? 'disabled' : ''}>
          ${heartSvg()}
          <span>${likedSet.has(chat.id) ? 'אהבתי!' : 'לייק'}</span>
        </button>
      </div>
    </div>
  `;
}

async function loadFeed() {
  try {
    const res = await fetch('/api/public/chats');
    const chats = await res.json();
    chats.sort((a, b) => b.voteCount - a.voteCount);
    latestChats = chats;
    renderFeed(chats);
    renderCarousel(chats);
    updateNextTargetWidget();
  } catch (err) {
    // Keep whatever was already rendered; a transient poll failure isn't worth
    // wiping the visible feed.
    console.error('Failed to load leaderboard feed', err);
  }
}

function wireLikeButtons(container) {
  container.querySelectorAll('.like-btn').forEach(btn => {
    btn.addEventListener('click', () => castLike(btn));
  });
}

const FULL_GRID_PAGE_SIZE = 9;
let fullGridVisibleCount = FULL_GRID_PAGE_SIZE;

function renderFeed(chats) {
  const grid = document.getElementById('chat-grid');
  const loadMoreBtn = document.getElementById('btn-load-more');
  if (chats.length === 0) {
    grid.innerHTML = '<div class="empty-feed">עוד אין צ\'אטים בלידרבורד - תהיה הראשון לדבר עם נהוראי!</div>';
    loadMoreBtn.style.display = 'none';
    return;
  }
  const likedSet = getLikedSet();
  const visible = chats.slice(0, fullGridVisibleCount);
  grid.innerHTML = visible.map((chat, idx) => renderChatCard(chat, idx, likedSet)).join('');
  wireLikeButtons(grid);
  loadMoreBtn.style.display = chats.length > fullGridVisibleCount ? '' : 'none';
}

function renderCarousel(chats) {
  const carousel = document.getElementById('top-carousel');
  if (!carousel) return;
  const top = chats.slice(0, 5);
  if (top.length === 0) {
    carousel.innerHTML = '<div class="empty-feed">עוד אין קרעים להראות</div>';
    return;
  }
  const likedSet = getLikedSet();
  carousel.innerHTML = top.map((chat, idx) => renderChatCard(chat, idx, likedSet)).join('');
  wireLikeButtons(carousel);
}

async function castLike(btn) {
  const chatId = btn.dataset.chatId;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('liked', 'pulsed');
  setTimeout(() => btn.classList.remove('pulsed'), 350);

  try {
    const res = await fetch('/api/public/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    });
    if (res.ok) {
      markLiked(chatId);
      btn.querySelector('span').textContent = 'אהבתי!';
      loadFeed();
    } else {
      // Already liked (409) or some other rejection - reflect it as liked
      // either way since a retry can't succeed for this voter.
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) markLiked(chatId);
      btn.querySelector('span').textContent = data.error === undefined ? 'אהבתי!' : 'לא זמין';
    }
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('liked');
  }
}

// ---------- "Show all chats" button - reveals the full grid on demand
// instead of dumping it on the page by default (nobody reads a wall of
// dozens of chats sitting there unasked for) ----------

function setupShowAllButton() {
  const btn = document.getElementById('btn-show-all');
  const section = document.getElementById('full-grid-section');
  if (!btn || !section) return;

  btn.addEventListener('click', () => {
    const revealed = section.classList.toggle('revealed');
    btn.textContent = revealed ? 'להסתיר את הצ\'אטים ⬆️' : 'לראות את כל הצ\'אטים של נהוראי ⬇️';
    if (revealed) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

function setupLoadMoreButton() {
  const btn = document.getElementById('btn-load-more');
  if (!btn) return;
  btn.addEventListener('click', () => {
    fullGridVisibleCount += FULL_GRID_PAGE_SIZE;
    renderFeed(latestChats);
  });
}

// ---------- Cinematic Intro Splash Screen & Screen Shake ----------

function setupCinematicIntro() {
  const overlay = document.getElementById('intro-overlay');
  const video = document.getElementById('intro-video');
  const soundBtn = document.getElementById('intro-sound-btn');
  const shatterEngine = document.getElementById('glass-shatter-engine');
  const ctaBtn = document.getElementById('cta-signup-btn');

  if (!overlay || !video) return;

  let finished = false;
  let shatterTriggered = false;

  const createRealisticShards = () => {
    const container = document.getElementById('shards-container');
    if (!container || container.children.length > 0) return;

    const numShards = 36;
    for (let i = 0; i < numShards; i++) {
      const shard = document.createElement('div');
      shard.className = 'dynamic-shard';

      // Cluster origin around impact center (52% X, 48% Y)
      const centerX = 52 + (Math.random() * 26 - 13);
      const centerY = 48 + (Math.random() * 26 - 13);
      const width = 7 + Math.random() * 16;
      const height = 7 + Math.random() * 16;

      shard.style.width = `${width}vw`;
      shard.style.height = `${height}vh`;
      shard.style.left = `${centerX - width / 2}vw`;
      shard.style.top = `${centerY - height / 2}vh`;

      // Random jagged 4-point polygon geometry
      const p1x = Math.floor(Math.random() * 30);
      const p1y = Math.floor(Math.random() * 30);
      const p2x = Math.floor(70 + Math.random() * 30);
      const p2y = Math.floor(Math.random() * 30);
      const p3x = Math.floor(70 + Math.random() * 30);
      const p3y = Math.floor(70 + Math.random() * 30);
      const p4x = Math.floor(Math.random() * 30);
      const p4y = Math.floor(70 + Math.random() * 30);
      shard.style.clipPath = `polygon(${p1x}% ${p1y}%, ${p2x}% ${p2y}%, ${p3x}% ${p3y}%, ${p4x}% ${p4y}%)`;

      // Explosion outward physics vector
      const angle = (i / numShards) * Math.PI * 2 + (Math.random() * 0.5 - 0.25);
      const dist = 38 + Math.random() * 62;
      const flyX = Math.cos(angle) * dist;
      const flyY = Math.sin(angle) * dist + (14 + Math.random() * 28);

      shard.style.setProperty('--fly-x-mid', `${flyX * 0.32}vw`);
      shard.style.setProperty('--fly-y-mid', `${flyY * 0.28}vh`);
      shard.style.setProperty('--fly-x', `${flyX}vw`);
      shard.style.setProperty('--fly-y', `${flyY}vh`);

      // 3D rotations during flight
      shard.style.setProperty('--rot-x-mid', `${Math.random() * 180 - 90}deg`);
      shard.style.setProperty('--rot-y-mid', `${Math.random() * 180 - 90}deg`);
      shard.style.setProperty('--rot-z-mid', `${Math.random() * 180 - 90}deg`);
      shard.style.setProperty('--rot-x', `${(Math.random() * 720 - 360).toFixed(1)}deg`);
      shard.style.setProperty('--rot-y', `${(Math.random() * 720 - 360).toFixed(1)}deg`);
      shard.style.setProperty('--rot-z', `${(Math.random() * 720 - 360).toFixed(1)}deg`);

      shard.style.animationDelay = `${(Math.random() * 0.08).toFixed(3)}s`;
      container.appendChild(shard);
    }
  };

  const triggerShatter = () => {
    if (shatterTriggered) return;
    shatterTriggered = true;

    // Shake the screen violently when the chair strikes
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 650);

    // Populate shards and ignite the tempered glass shatter engine
    createRealisticShards();
    if (shatterEngine) {
      shatterEngine.classList.add('shatter-active');
    }
  };

  const finishIntro = () => {
    if (finished) return;
    finished = true;
    triggerShatter();

    if (ctaBtn) {
      ctaBtn.classList.add('pulse');
      setTimeout(() => ctaBtn.classList.remove('pulse'), 4200);
    }

    // Wait 950ms (~1 full second of glass cracking and outward explosion) before starting slow 1.5s fade out
    setTimeout(() => {
      overlay.classList.add('fade-out');
    }, 950);

    setTimeout(() => {
      overlay.style.display = 'none';
      video.pause();
    }, 2450);
  };

  // Chair throw moment trigger near end of video
  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const remaining = video.duration - video.currentTime;
    if (!shatterTriggered && remaining < 0.72) {
      triggerShatter();
    }
    if (!finished && remaining < 0.18) {
      finishIntro();
    }
  });

  video.addEventListener('ended', finishIntro);

  const enableSound = () => {
    if (video.muted) {
      video.muted = false;
      if (soundBtn) {
        soundBtn.innerHTML = '🔊 סאונד פועל במלוא העוצמה';
        soundBtn.classList.add('active');
      }
      // CRITICAL FOR MOBILE SAFARI / CHROME ON PHONE: Explicitly resume play so mobile touch never freezes or pauses playback!
      const p = video.play();
      if (p !== undefined) {
        p.catch(() => {
          video.muted = true;
          video.play().catch(() => {});
        });
      }
    }
  };

  if (soundBtn) {
    soundBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (video.muted) {
        enableSound();
      } else {
        video.muted = true;
        soundBtn.innerHTML = '🔇 לחץ להפעלת שמע';
        soundBtn.classList.remove('active');
      }
    });
  }

  // Unmute automatically on tap/click without freezing mobile video
  const unlockSoundEvents = ['click', 'touchend'];
  const unlockHandler = (e) => {
    if (video.muted) {
      enableSound();
      unlockSoundEvents.forEach(evt => window.removeEventListener(evt, unlockHandler, true));
    }
  };
  unlockSoundEvents.forEach(evt => window.addEventListener(evt, unlockHandler, true));

  // Attempt unmuted play first!
  video.muted = false;
  video.play().then(() => {
    if (soundBtn) {
      soundBtn.innerHTML = '🔊 סאונד פועל במלוא העוצמה';
      soundBtn.classList.add('active');
    }
  }).catch(() => {
    // If browser blocks unmuted play, fallback to muted immediately and prompt tap
    video.muted = true;
    if (soundBtn) {
      soundBtn.innerHTML = '⚡ לחץ/גע במסך להפעלת סאונד';
      soundBtn.classList.remove('active');
    }
    video.play().catch(() => {});
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
  const stepPostsignup = document.getElementById('signup-step-postsignup');
  const consentCheckbox = document.getElementById('consent-checkbox');
  const continueBtn = document.getElementById('signup-continue');
  const submitBtn = document.getElementById('signup-submit');
  const errorEl = document.getElementById('signup-error');
  let pendingWaLink = null;

  function showStep(step) {
    [stepGuide, stepForm, stepPostsignup].forEach(s => { s.style.display = 'none'; });
    step.style.display = '';
  }

  function openModal() {
    modal.classList.add('open');
    showStep(stepGuide);
    consentCheckbox.checked = false;
    continueBtn.disabled = true;
    errorEl.textContent = '';
  }
  function closeModal() { modal.classList.remove('open'); }

  document.getElementById('cta-signup-btn').addEventListener('click', openModal);
  document.getElementById('signup-cancel-1').addEventListener('click', closeModal);
  document.getElementById('signup-back').addEventListener('click', () => showStep(stepGuide));

  consentCheckbox.addEventListener('change', () => {
    continueBtn.disabled = !consentCheckbox.checked;
  });

  continueBtn.addEventListener('click', () => {
    if (!consentCheckbox.checked) return;
    showStep(stepForm);
  });

  submitBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const displayAlias = document.getElementById('alias-input').value.trim();
    const phone = document.getElementById('phone-input').value.trim();
    const topicCustom = document.getElementById('topic-custom').value.trim();
    const topicSelect = document.getElementById('topic-select').value;
    const topic = topicCustom || topicSelect;
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
      pendingWaLink = data.waLink;
      showStep(stepPostsignup);
    } catch (err) {
      errorEl.textContent = 'משהו השתבש, נסה שוב';
      submitBtn.disabled = false;
      submitBtn.textContent = 'קדימה, תפתח לי וואטסאפ';
    }
  });

  document.getElementById('signup-go-whatsapp').addEventListener('click', () => {
    if (pendingWaLink) window.location.href = pendingWaLink;
  });
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', () => {
  setupCinematicIntro();
  loadStatusWidget();
  startTelemetryLoop();
  loadFeed();
  setInterval(loadFeed, POLL_INTERVAL_MS);
  setInterval(updateNextTargetWidget, 6000);
  setupDocsTabs();
  setupSignupFlow();
  setupShowAllButton();
  setupLoadMoreButton();
});
