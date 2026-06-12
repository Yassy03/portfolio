/* ==================================================================
   Interactive Portrait — tracking logic

   The video is NEVER played. We pause it and set `video.currentTime`
   to a frame chosen from where the cursor is. Every frame is a keyframe,
   so seeking is instant.

   The loop is one continuous take:
     idle(front) -> [wake] -> up -> left -> down -> right -> up -> [settle] -> front

   Calibration pins real frames to head directions around a circle and
   interpolates between them. Up appears twice — entering (cardinals.up)
   and returning (cardinals.upEnd) — which is the loop seam. The four
   diagonals are OPTIONAL; leave them null and the code interpolates
   straight through.
   ================================================================== */

const CONFIG = {
  fps: 25,

  idleFrame: 0,    // front / resting pose
  lastFrame: 243,  // front again (end of settle tail)

  // Frame for each head direction. up + upEnd are required (the seam);
  // the rest are optional refinements (null = auto-interpolate).
  cardinals: {
    up:        27,    // nose UP (enters circle / seam start)
    upLeft:    60,    // ↖
    left:      74,    // ←
    downLeft:  96,    // ↙
    down:      129,   // ↓
    downRight: 157,   // ↘
    right:     171,   // →
    upRight:   183,   // ↗
    upEnd:     223,   // nose UP again (leaves circle / seam end)
  },

  anchorX: 0.5,   // pivot for cursor angle, fraction of viewport
  anchorY: 0.42,

  smoothing:     0.16,
  idleTimeoutMs: 2200,   // desktop: how long after the last move before it relaxes
  idleTimeoutPhoneMs: 650, // touch: shorter, since there's no hover to hold the pose
  settleSpeed:   0.045,  // how fast it eases back to rest (lower = slower/calmer)
  navTurnSpeed:  0.11,   // how fast the head turns toward a tapped folder (lower = slower)
  deadzonePx:    36,

  upAngleDeg: -90,
  dirSign: 1,
};

// phase 0..1 around the circle for each direction key
const DIAL = [
  ['up', 'up', 0], ['upLeft', 'up-left', 0.125], ['left', 'left', 0.25],
  ['downLeft', 'down-left', 0.375], ['down', 'down', 0.5],
  ['downRight', 'down-right', 0.625], ['right', 'right', 0.75],
  ['upRight', 'up-right', 0.875],
];

// ---- elements ----
const stage    = document.getElementById('stage');
const portrait = document.getElementById('portrait');
const video    = document.getElementById('video');
const panel    = document.getElementById('panel');
const readout  = document.getElementById('readout');
const debug    = document.getElementById('debug');
const dbgCtx   = debug.getContext('2d');

// ---- runtime state ----
let currentFrame = CONFIG.idleFrame;
let state = 'idle';
let settleTarget = CONFIG.lastFrame;
let lastMove = 0;
let mouse = { x: 0, y: 0, inside: false };
let scrubbing = false;   // latched while calibrating; cleared on stage move
let scrubFrame = 0;
let frozen = false;          // modal open → hold the current frame so it can't glitch
let hoveringFolder = false;  // mouse over a folder → keep that pose alive (no idle-out)
let navPending = false;      // mid folder-tap: head is turning toward it, modal not open yet
let poseTarget = 0;          // frame the head is turning toward during a folder navigation

// ---- helpers ----
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod   = (n, m) => ((n % m) + m) % m;

// touch devices have no hover, so the head can't be "held" on a folder — relax sooner
const isCoarsePointer = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const idleTimeout = () => isCoarsePointer ? CONFIG.idleTimeoutPhoneMs : CONFIG.idleTimeoutMs;

function seek(frame) {
  // skip if the video can't seek yet, or a previous seek is still in flight —
  // hammering currentTime mid-seek makes a cold-loaded video thrash and never paint
  if (video.readyState < 2 || video.seeking) return;
  const t = clamp(frame, 0, CONFIG.lastFrame) / CONFIG.fps;
  video.currentTime = t + 0.0001;
}

function anchorPoint() {
  const r = portrait.getBoundingClientRect();
  return { x: r.left + r.width * CONFIG.anchorX, y: r.top + r.height * CONFIG.anchorY };
}

function cursorAngleDeg() {
  const a = anchorPoint();
  return Math.atan2(mouse.y - a.y, mouse.x - a.x) * 180 / Math.PI;
}

function cursorPhase(angleDeg) {
  return mod((CONFIG.upAngleDeg - angleDeg) * CONFIG.dirSign / 360, 1);
}

// ordered [phase, frame] of the points that are actually set
function calPoints() {
  const c = CONFIG.cardinals;
  const order = [...DIAL.map(([k, , ph]) => [k, ph]), ['upEnd', 1]];
  return order.filter(([k]) => c[k] != null).map(([k, ph]) => [ph, c[k]]);
}

function phaseToFrame(p) {
  const pts = calPoints();
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, f0] = pts[i], [p1, f1] = pts[i + 1];
    if (p <= p1) { const t = (p - p0) / (p1 - p0); return f0 + (f1 - f0) * t; }
  }
  return pts[pts.length - 1][1];
}

// inverse: frame -> phase (for the live dot). null if outside the circle.
function frameToPhase(f) {
  const pts = calPoints();
  if (f < pts[0][1] || f > pts[pts.length - 1][1]) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, f0] = pts[i], [p1, f1] = pts[i + 1];
    if (f <= f1) { const t = (f - f0) / (f1 - f0 || 1); return p0 + (p1 - p0) * t; }
  }
  return 1;
}

function cyclicEase(cur, target, k) {
  const start = CONFIG.cardinals.up, end = CONFIG.cardinals.upEnd;
  const span = end - start;
  let d = target - cur;
  d = mod(d + span / 2, span) - span / 2;
  let nf = cur + d * k;
  return mod(nf - start, span) + start;
}

const easeLinear = (cur, target, k) => cur + (target - cur) * k;
const near = (a, b, eps = 1.0) => Math.abs(a - b) <= eps;

// ---- main loop ----
function tick(now) {
  if (frozen) {
    // modal is open: hold the frame exactly where it is (no seeking churn)
  } else if (scrubbing) {
    currentFrame = scrubFrame;
  } else {
    if (hoveringFolder) lastMove = now;   // hovering a folder keeps the pose from relaxing
    const a = anchorPoint();
    const idleFor = now - lastMove;
    const dist = Math.hypot(mouse.x - a.x, mouse.y - a.y);

    switch (state) {
      case 'idle':
        currentFrame = easeLinear(currentFrame, CONFIG.idleFrame, 0.12);
        break;
      case 'waking':
        currentFrame = easeLinear(currentFrame, CONFIG.cardinals.up, 0.14);
        if (near(currentFrame, CONFIG.cardinals.up, 1.5)) state = 'tracking';
        break;
      case 'tracking': {
        if (dist > CONFIG.deadzonePx) {
          const target = phaseToFrame(cursorPhase(cursorAngleDeg()));
          currentFrame = cyclicEase(currentFrame, target, CONFIG.smoothing);
        }
        if (idleFor > idleTimeout() || !mouse.inside) {
          const toStart = currentFrame - CONFIG.cardinals.up;
          const toEnd   = CONFIG.cardinals.upEnd - currentFrame;
          settleTarget = toStart < toEnd ? CONFIG.idleFrame : CONFIG.lastFrame;
          state = 'settling';
        }
        break;
      }
      case 'posing': {
        // turning toward a tapped folder — always the SHORT way, never a full spin.
        const up = CONFIG.cardinals.up, upEnd = CONFIG.cardinals.upEnd;
        if (currentFrame < up - 0.5) {
          // resting/front region (below the circle): bridge up onto the circle first
          currentFrame = easeLinear(currentFrame, up, CONFIG.navTurnSpeed);
        } else if (currentFrame > upEnd + 0.5) {
          // settle-tail region (above the circle): bridge back onto the circle first
          currentFrame = easeLinear(currentFrame, upEnd, CONFIG.navTurnSpeed);
        } else {
          // on the circle: rotate the shortest arc to the folder pose
          currentFrame = cyclicEase(currentFrame, poseTarget, CONFIG.navTurnSpeed);
        }
        break;
      }
      case 'settling':
        currentFrame = easeLinear(currentFrame, settleTarget, CONFIG.settleSpeed);
        if (near(currentFrame, settleTarget, 1.0)) { currentFrame = CONFIG.idleFrame; state = 'idle'; }
        break;
    }
  }

  seek(currentFrame);
  drawDebug();
  updateReadout();
  updateDot();
  requestAnimationFrame(tick);
}

// ---- input (mouse + touch + pen, unified via Pointer Events) ----
let primed = false;
function primeVideo() {          // a paused video won't render a seeked frame until
  if (primed) return;            // it's "woken" by playback once. Autoplay covers most
  try {                          // browsers; incognito/Safari block it, so we retry on
    const p = video.play();      // every interaction until a real gesture is accepted.
    if (p && p.then) {
      // only mark primed once play actually succeeds, so a blocked attempt retries
      p.then(() => { primed = true; video.pause(); }).catch(() => {});
    } else {
      primed = true; video.pause();
    }
  } catch (_) {}
}
// a genuine tap/click anywhere is always allowed to wake media — even in incognito
['pointerdown', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, primeVideo, { capture: true, passive: true }));

// fade the "drag finger" hint away the first time the user does anything
let hintDismissed = false;
function dismissHint() {
  if (hintDismissed) return;
  hintDismissed = true;
  const h = document.getElementById('hint');
  if (!h) return;
  // freeze the blink at its current opacity, then fade smoothly to 0 (no jump)
  h.style.opacity = getComputedStyle(h).opacity;
  h.style.animation = 'none';
  void h.offsetWidth;            // reflow so the next change transitions
  h.style.opacity = '0';
}

function engage(e) {
  if (!e.isPrimary) return;      // ignore secondary fingers on multi-touch
  primeVideo();                  // wake on first move too (works where muted play is allowed)
  dismissHint();
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
  lastMove = performance.now();
  scrubbing = false;             // touching the portrait resumes live tracking
  if (state === 'idle' || state === 'settling') {
    if (e.pointerType === 'mouse') {
      state = 'waking';          // desktop: keep the gentle front→up→track intro
    } else {
      // touch: orient straight to the finger instead of waking up and rotating
      // around to it (no hover on touch, so each press starts cold from front)
      currentFrame = phaseToFrame(cursorPhase(cursorAngleDeg()));
      state = 'tracking';
    }
  }
}

stage.addEventListener('pointerdown', (e) => { primeVideo(); engage(e); });
stage.addEventListener('pointermove', (e) => {
  // touch/pen only report a position WHILE pressed; a mouse hovers freely
  if (e.pointerType !== 'mouse' && e.buttons === 0) return;
  engage(e);
});
// finger lifted / cancelled → no position any more, so relax back to idle
stage.addEventListener('pointerup',     (e) => { if (e.pointerType !== 'mouse') mouse.inside = false; });
stage.addEventListener('pointercancel', ()  => { mouse.inside = false; });
// the mouse leaving the window relaxes too
stage.addEventListener('pointerleave',  (e) => { if (e.pointerType === 'mouse') mouse.inside = false; });

// ---- debug overlay ----
function drawDebug() {
  if (debug.hidden) return;
  if (debug.width !== innerWidth) { debug.width = innerWidth; debug.height = innerHeight; }
  dbgCtx.clearRect(0, 0, debug.width, debug.height);
  const a = anchorPoint();
  dbgCtx.fillStyle = '#ff2e63';
  dbgCtx.beginPath(); dbgCtx.arc(a.x, a.y, 5, 0, Math.PI * 2); dbgCtx.fill();
  dbgCtx.strokeStyle = '#ff2e6388'; dbgCtx.lineWidth = 1.5;
  dbgCtx.beginPath(); dbgCtx.moveTo(a.x, a.y); dbgCtx.lineTo(mouse.x, mouse.y); dbgCtx.stroke();
}

function updateReadout() {
  readout.textContent = `frame ${currentFrame.toFixed(1)} · ${state}`;
}

/* ==================================================================
   Calibration panel
   ================================================================== */
const scrub      = document.getElementById('scrub');
const scrubVal   = document.getElementById('scrubVal');
const dial       = document.getElementById('dial');
const dialDot    = document.getElementById('dialDot');
const dialCenter = document.getElementById('dialCenter');

const DIAL_R = 64; // px from centre to a node

// place an element at a phase around the dial
function phasePos(p) {
  const ang = (CONFIG.upAngleDeg - p * 360) * Math.PI / 180;
  return { x: 80 + DIAL_R * Math.cos(ang), y: 80 + DIAL_R * Math.sin(ang) };
}

// build the eight clickable direction nodes
const nodeEls = {};
DIAL.forEach(([key, label, phase]) => {
  const el = document.createElement('button');
  el.className = 'dial__node';
  el.dataset.key = key;
  const pos = phasePos(phase);
  el.style.left = pos.x + 'px';
  el.style.top  = pos.y + 'px';
  el.innerHTML = `<span class="dial__lbl">${label}</span><span class="dial__frame">—</span>`;
  el.addEventListener('click', () => {
    CONFIG.cardinals[key] = scrubFrame; // tag current scrub frame
    refreshPanel();
  });
  dial.appendChild(el);
  nodeEls[key] = el;
});

function updateDot() {
  const ph = frameToPhase(currentFrame);
  if (ph == null) { dialDot.hidden = true; }
  else {
    const pos = phasePos(ph);
    dialDot.hidden = false;
    dialDot.style.left = pos.x + 'px';
    dialDot.style.top  = pos.y + 'px';
  }
  dialCenter.textContent = '#' + Math.round(currentFrame);
}

// reflect CONFIG into every control
function refreshPanel() {
  document.querySelectorAll('[data-cfg]').forEach((el) => { el.value = getPath(CONFIG, el.dataset.cfg); });
  DIAL.forEach(([key]) => {
    const v = CONFIG.cardinals[key];
    const node = nodeEls[key];
    node.querySelector('.dial__frame').textContent = v == null ? 'auto' : '#' + v;
    node.classList.toggle('is-set', v != null);
    node.classList.toggle('is-required', key === 'up');
  });
  document.getElementById('showIdle').textContent  = '#' + CONFIG.idleFrame;
  document.getElementById('showUpEnd').textContent = '#' + CONFIG.cardinals.upEnd;
}

const getPath = (o, p) => p.split('.').reduce((x, k) => x[k], o);
function setPath(o, p, v) {
  const ks = p.split('.'); const last = ks.pop();
  ks.reduce((x, k) => x[k], o)[last] = v;
}

document.querySelectorAll('[data-cfg]').forEach((el) => {
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    if (!Number.isNaN(v)) setPath(CONFIG, el.dataset.cfg, v);
  });
});

// scrubbing latches so the pose holds while you click a direction
scrub.addEventListener('input', () => {
  scrubbing = true;
  scrubFrame = parseInt(scrub.value, 10);
  scrubVal.textContent = scrubFrame;
});

document.querySelectorAll('[data-set]').forEach((btn) => {
  btn.addEventListener('click', () => { setPath(CONFIG, btn.dataset.set, scrubFrame); refreshPanel(); });
});

document.getElementById('resetOpt').addEventListener('click', () => {
  ['upLeft', 'downLeft', 'downRight', 'upRight', 'left', 'down', 'right'].forEach((k) => {
    if (k === 'left' || k === 'down' || k === 'right') return; // keep the main 4
    CONFIG.cardinals[k] = null;
  });
  refreshPanel();
});

document.getElementById('showAnchor').addEventListener('change', (e) => { debug.hidden = !e.target.checked; });
document.getElementById('copyCfg').addEventListener('click', () => {
  navigator.clipboard?.writeText(JSON.stringify(CONFIG, null, 2));
  const b = document.getElementById('copyCfg'); const t = b.textContent;
  b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = t), 1200);
});

function togglePanel(force) {
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (open) refreshPanel();
}
document.getElementById('panelClose').addEventListener('click', () => togglePanel(false));
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'c' && e.target.tagName !== 'INPUT') togglePanel();
});

/* ==================================================================
   Folder navigation + glass overlays
   ================================================================== */
// Formspree endpoint — submissions are emailed to the account owner.
// If blanked, the form falls back to opening a pre-filled email instead.
const FORM_ENDPOINT = 'https://formspree.io/f/mwvjreyd';

const overlay    = document.getElementById('overlay');
const sheetEl     = document.getElementById('sheet');
const sheetBodies = document.querySelectorAll('.sheet__body');

function openModal(id) {
  primeVideo();                       // wake iOS video even if first tap is a folder
  frozen = true;                      // freeze the pose so typing can't glitch the video
  hoveringFolder = false;
  sheetBodies.forEach((b) => { b.hidden = b.id !== 'modal-' + id; });
  sheetEl.classList.toggle('sheet--contact', id === 'contact'); // contact is smaller
  overlay.hidden = false;             // appear instantly at full blur (no fade)
  const focusable = overlay.querySelector('.sheet__body:not([hidden]) input, .sheet__body:not([hidden]) a');
  focusable?.focus({ preventScroll: true });
}

function closeModal() {
  overlay.hidden = true;              // dismiss instantly
  // resume from exactly where the head paused, then let it follow the cursor
  // naturally on the next move (no scrub-back-to-idle animation to glitch)
  frozen = false;
  hoveringFolder = false;
  navPending = false;
  mouse.inside = true;
  lastMove = performance.now();
  state = 'tracking';

  // reset the portfolio form + submit button for next time (however it was dismissed)
  reqform.reset();
  const sb = reqform.querySelector('.reqsubmit');
  sb.textContent = 'Submit request';
  sb.style.background = '';
  sb.style.color = '';
  sb.style.fontFamily = '';
  sb.style.fontSize = '';
  reqStatus.textContent = '';
  reqStatus.classList.remove('is-error');
}

// where a folder sits on screen → the frame whose head points at it
function folderTargetFrame(btn) {
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const a = anchorPoint();
  const ang = Math.atan2(cy - a.y, cx - a.x) * 180 / Math.PI;
  return { cx, cy, frame: phaseToFrame(cursorPhase(ang)) };
}

// Tap/click a folder → the head turns to face it (video reacts on press),
// and the modal opens once the head is facing it. On desktop the hover has
// usually pointed it there already, so this opens near-instantly.
function navigateToFolder(btn) {
  primeVideo();
  dismissHint();
  const { cx, cy, frame } = folderTargetFrame(btn);
  mouse.x = cx; mouse.y = cy;
  lastMove = performance.now();
  scrubbing = false;
  // turn the SHORT way to the folder pose from wherever the head is now — the
  // 'posing' state never spins, whether you were dragging or came in cold.
  poseTarget = frame;
  state = 'posing';

  if (navPending) return;
  navPending = true;
  const id = btn.dataset.modal;
  const cap = performance.now() + 2500;  // safety only: open even if it never quite arrives
  (function waitUntilFacing() {
    // open once the head has actually arrived at the pose (paced), not on a timer
    if ((state === 'posing' && near(currentFrame, frame, 2.5)) || performance.now() > cap) {
      navPending = false;
      openModal(id);
      return;
    }
    requestAnimationFrame(waitUntilFacing);
  })();
}

document.querySelectorAll('.folder').forEach((btn) => {
  btn.addEventListener('click', () => navigateToFolder(btn));
  // mouse hover (desktop): point the head at the folder and hold it there
  btn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hoveringFolder = true; engage(e); } });
  btn.addEventListener('pointermove',  (e) => { if (e.pointerType === 'mouse') { hoveringFolder = true; engage(e); } });
  btn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hoveringFolder = false; });
});
document.getElementById('sheetClose').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });

// ---- success: just change the button label in place; user clicks off to dismiss ----
function playSuccess() {
  const btn = reqform.querySelector('.reqsubmit');
  btn.textContent = 'Submitted';
  btn.style.background = '#ff3f77';                       // button turns pink
  btn.style.color = '#ffffff';                           // white label
  btn.style.fontFamily = '"pf-pixelscript", sans-serif'; // pixel-script
  btn.style.fontSize = '30px';                           // bigger
}

// ---- portfolio form submit ----
const reqform   = document.getElementById('reqform');
const reqStatus = document.getElementById('reqStatus');

reqform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = reqform.querySelector('.reqsubmit');
  if (btn.disabled) return;           // guard double-submit

  const data = Object.fromEntries(new FormData(reqform).entries());

  // No backend wired up yet → fall back to a pre-filled email draft.
  if (!FORM_ENDPOINT) {
    const body = `Name: ${data.name}\nCompany: ${data.company || '—'}\nEmail: ${data.email}`;
    location.href = `mailto:yasavdji@gmail.com?subject=${encodeURIComponent('Portfolio request')}&body=${encodeURIComponent(body)}`;
    return;
  }

  btn.disabled = true;
  reqStatus.classList.remove('is-error');
  try {
    const res = await fetch(FORM_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new FormData(reqform),
    });
    if (!res.ok) throw new Error('bad status');
    reqStatus.textContent = '';
    playSuccess();                    // button label changes; user clicks off to dismiss
  } catch (_) {
    reqStatus.classList.add('is-error');
    reqStatus.textContent = 'Something went wrong. Try again or email directly.';
  } finally {
    btn.disabled = false;
  }
});

/* ==================================================================
   Boot
   ================================================================== */
function boot() {
  scrub.max = CONFIG.lastFrame;
  refreshPanel();
  primeVideo();               // wake the renderer on load (muted inline play is allowed)
  seek(CONFIG.idleFrame);
  requestAnimationFrame(tick);
}
if (video.readyState >= 1) boot();
else video.addEventListener('loadedmetadata', boot, { once: true });

// as soon as a real frame is decoded, hold it on the idle pose (don't keep playing)
video.addEventListener('loadeddata', () => { video.pause(); seek(CONFIG.idleFrame); }, { once: true });

video.addEventListener('error', () => {
  console.warn('Could not load FinalLoop_web.mp4 — keep it next to index.html and run a local server (see README).');
});
