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
  const ctaBtn = document.getElementById('cta-signup-btn');

  if (!overlay || !video) return;

  let finished = false;
  let transitionTriggered = false;

  const triggerCreativeReveal = () => {
    if (transitionTriggered) return;
    transitionTriggered = true;

    // Shake the screen violently right when the chair strikes
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 650);

    // Trigger the creative warp-speed zoom and page reveal bounce animation
    overlay.classList.add('creative-reveal');
    document.body.classList.add('reveal-active');

    if (ctaBtn) {
      ctaBtn.classList.add('pulse');
      setTimeout(() => ctaBtn.classList.remove('pulse'), 4200);
    }
  };

  const finishIntro = () => {
    if (finished) return;
    finished = true;
    triggerCreativeReveal();

    setTimeout(() => {
      overlay.style.display = 'none';
      video.pause();
      video.removeAttribute('src');
      video.load();
    }, 880);
  };

  // Chair throw moment trigger near end of video
  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const remaining = video.duration - video.currentTime;
    if (!transitionTriggered && remaining < 0.65) {
      triggerCreativeReveal();
    }
    if (!finished && remaining < 0.15) {
      finishIntro();
    }
  });

  video.addEventListener('ended', finishIntro);
  video.addEventListener('error', finishIntro);
  video.addEventListener('stalled', () => {
    setTimeout(() => { if (!finished && video.currentTime > 0) finishIntro(); }, 1500);
  });
  overlay.addEventListener('click', () => {
    if (video.currentTime > 1.2 || !video.duration) finishIntro();
  });

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

// ---------- Ambient Cyberpunk Background Slideshow & Profile Photo Cycle ----------

function setupAmbientSlideshow() {
  const slides = document.querySelectorAll('.ambient-bg-slide');
  const heroImg = document.getElementById('hero-logo-img');
  if (!slides.length) return;

  const slideUrls = [
    '/nehorai/slide1.jpg',
    '/nehorai/slide2.jpg',
    '/nehorai/slide3.jpg',
    '/nehorai/slide4.jpg',
    '/nehorai/slide5.jpg',
    '/nehorai/character.jpg'
  ];

  let currentIdx = 0;
  // Must stay >= the slower of the desktop zoom transition (14s, see
  // .ambient-bg-slide's transform transition) and the mobile reveal-pan
  // animation (24s, mobileStoryReveal) - otherwise a slide gets swapped out
  // mid-animation and neither ever plays to completion.
  setInterval(() => {
    const introOverlay = document.getElementById('intro-overlay');
    if (introOverlay && introOverlay.style.display !== 'none') return;

    slides[currentIdx].classList.remove('active');
    currentIdx = (currentIdx + 1) % slides.length;
    slides[currentIdx].classList.add('active');
  }, 24500);
}

// ---------- VIP Story Reels Modal (video gallery, TikTok/Reels style) ----------

const LIKED_VIDEOS_STORAGE_KEY = 'nehoraiLikedVideoIds';
const DOUBLE_TAP_MS = 300;
const HEART_SVG_PATH = 'M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.6 5 8 5 10 6.5 12 9c2-2.5 4-4 6.4-4C22 5 23.6 8.4 22 11.7 19.5 16.4 12 21 12 21z';

let storyVideos = [];
let currentVideoIndex = 0;
let reelObserver = null;

function getLikedVideoSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKED_VIDEOS_STORAGE_KEY) || '[]'));
  } catch (_) {
    return new Set();
  }
}

function markVideoLiked(videoId) {
  const set = getLikedVideoSet();
  set.add(videoId);
  localStorage.setItem(LIKED_VIDEOS_STORAGE_KEY, JSON.stringify([...set]));
}

function unmarkVideoLiked(videoId) {
  const set = getLikedVideoSet();
  set.delete(videoId);
  localStorage.setItem(LIKED_VIDEOS_STORAGE_KEY, JSON.stringify([...set]));
}

async function fetchStoryVideos() {
  try {
    const res = await fetch('/api/public/videos');
    storyVideos = await res.json();
  } catch (err) {
    storyVideos = [];
  }
}

function renderReelItemHtml(video, index) {
  const liked = getLikedVideoSet().has(video.id);
  return `
    <div class="story-reel-item" data-index="${index}" data-video-id="${escapeHtml(video.id)}">
      <video playsinline preload="none" src="${escapeHtml(video.url)}"></video>
      <div class="story-heart-burst"><svg viewBox="0 0 24 24"><path d="${HEART_SVG_PATH}"/></svg></div>
      <div class="story-side-actions">
        <button class="story-like-btn ${liked ? 'liked' : ''}">
          <svg viewBox="0 0 24 24"><path d="${HEART_SVG_PATH}"/></svg>
          <span class="story-like-count">${video.voteCount}</span>
        </button>
      </div>
      <div class="story-caption">${escapeHtml(video.caption || '')}</div>
    </div>
  `;
}

function setupStoryModal() {
  const trigger = document.getElementById('hero-story-trigger');
  const modal = document.getElementById('nehorai-story-modal');
  const closeBtn = document.getElementById('story-close-btn');
  const backdrop = document.getElementById('story-modal-backdrop');
  const scroller = document.getElementById('story-reel-scroller');
  const indexEl = document.getElementById('story-index-indicator');

  if (!trigger || !modal || !scroller) return;

  // A real on/off toggle - "liked" here means "this browser's vote is
  // currently recorded server-side", so it always reflects that truth
  // rather than a one-way "already voted, can never undo" flag.
  const setLikeButtonState = (item, liked, voteCount) => {
    const btn = item.querySelector('.story-like-btn');
    btn.classList.toggle('liked', liked);
    btn.querySelector('.story-like-count').textContent = voteCount;
  };

  const likeVideo = async (item, videoId) => {
    const video = storyVideos.find(v => v.id === videoId);
    if (!video) return;
    const btn = item.querySelector('.story-like-btn');
    btn.classList.add('liked', 'pulsed');
    setTimeout(() => btn.classList.remove('pulsed'), 350);

    try {
      const res = await fetch('/api/public/videos/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      if (res.ok || res.status === 409) {
        markVideoLiked(videoId);
        if (res.ok) video.voteCount += 1;
        setLikeButtonState(item, true, video.voteCount);
      } else {
        setLikeButtonState(item, false, video.voteCount);
      }
    } catch (err) {
      setLikeButtonState(item, false, video.voteCount);
    }
  };

  const unlikeVideo = async (item, videoId) => {
    const video = storyVideos.find(v => v.id === videoId);
    if (!video) return;
    const btn = item.querySelector('.story-like-btn');
    btn.classList.remove('liked');

    try {
      const res = await fetch('/api/public/videos/vote', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      if (res.ok || res.status === 409) {
        unmarkVideoLiked(videoId);
        if (res.ok) video.voteCount = Math.max(0, video.voteCount - 1);
        setLikeButtonState(item, false, video.voteCount);
      } else {
        setLikeButtonState(item, true, video.voteCount);
      }
    } catch (err) {
      setLikeButtonState(item, true, video.voteCount);
    }
  };

  const showHeartBurst = (item) => {
    const burst = item.querySelector('.story-heart-burst');
    burst.classList.remove('burst-active');
    void burst.offsetWidth; // force reflow so the animation can restart
    burst.classList.add('burst-active');
  };

  // ---- Tap disambiguation: single tap = play/pause, double tap = like ----
  let pendingTapTimer = null;
  let lastTapTime = 0;
  let lastTapVideoId = null;

  scroller.addEventListener('click', (e) => {
    const item = e.target.closest('.story-reel-item');
    if (!item) return;
    const videoId = item.dataset.videoId;

    // Like-button click: independent of tap timing, a plain toggle.
    if (e.target.closest('.story-like-btn')) {
      const alreadyLiked = item.querySelector('.story-like-btn').classList.contains('liked');
      if (alreadyLiked) unlikeVideo(item, videoId);
      else likeVideo(item, videoId);
      return;
    }

    const now = Date.now();
    if (lastTapVideoId === videoId && now - lastTapTime < DOUBLE_TAP_MS) {
      // Double tap: cancel the pending single-tap play/pause, like (never
      // unlike - matches Instagram's own double-tap semantics) + burst.
      clearTimeout(pendingTapTimer);
      lastTapTime = 0;
      lastTapVideoId = null;
      showHeartBurst(item);
      const alreadyLiked = item.querySelector('.story-like-btn').classList.contains('liked');
      if (!alreadyLiked) likeVideo(item, videoId);
      return;
    }

    lastTapTime = now;
    lastTapVideoId = videoId;
    pendingTapTimer = setTimeout(() => {
      const video = item.querySelector('video');
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }, DOUBLE_TAP_MS);
  });

  // ---- Native scroll-snap drives navigation; IntersectionObserver just
  // tracks which slide is actually in view to play/pause the right video
  // and keep the index indicator honest. ----
  const setupReelObserver = () => {
    if (reelObserver) reelObserver.disconnect();
    reelObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const video = entry.target.querySelector('video');
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          currentVideoIndex = parseInt(entry.target.dataset.index, 10);
          indexEl.textContent = `${currentVideoIndex + 1} / ${storyVideos.length}`;
          video.currentTime = 0;
          const p = video.play();
          if (p !== undefined) p.catch(() => { video.muted = true; video.play().catch(() => {}); });
        } else {
          video.pause();
        }
      });
    }, { root: scroller, threshold: [0, 0.6, 1] });

    scroller.querySelectorAll('.story-reel-item').forEach(item => reelObserver.observe(item));
  };

  const openStory = async () => {
    if (!storyVideos.length) await fetchStoryVideos();
    if (!storyVideos.length) return; // nothing to show
    scroller.innerHTML = storyVideos.map((v, i) => renderReelItemHtml(v, i)).join('');
    scroller.scrollTop = 0;
    currentVideoIndex = 0;
    indexEl.textContent = `1 / ${storyVideos.length}`;
    modal.classList.add('active');
    setupReelObserver();
  };

  const closeStory = () => {
    modal.classList.remove('active');
    scroller.querySelectorAll('video').forEach(v => v.pause());
  };

  trigger.addEventListener('click', openStory);
  if (closeBtn) closeBtn.addEventListener('click', closeStory);
  if (backdrop) backdrop.addEventListener('click', closeStory);

  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('active')) return;
    if (e.key === 'Escape') { closeStory(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const targetIdx = Math.max(0, Math.min(storyVideos.length - 1, currentVideoIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    const item = scroller.children[targetIdx];
    if (item) item.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Warm the video list in the background so the first tap opens instantly.
  fetchStoryVideos();
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
  setupAmbientSlideshow();
  setupStoryModal();
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
