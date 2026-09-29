// Small helpers shared by the app and the call screen.

export const TINTS = [
  ['#F2D3C4', '#7A2E12'],
  ['#D5E3D3', '#2F4A2C'],
  ['#D6DCE4', '#2B3A4E'],
  ['#E9DCC4', '#5A4520'],
  ['#E4D6E4', '#4F2D4F'],
  ['#F0E1B8', '#5C4A12'],
];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

export function avatar(user, size = 40, opts = {}) {
  const [bg, fg] = TINTS[(user?.color ?? 0) % TINTS.length];
  const dot = opts.online ? `<span class="dot" style="width:${Math.max(10, size * 0.26)}px;height:${Math.max(10, size * 0.26)}px"></span>` : '';
  return `<span class="av" style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.36)}px" aria-hidden="true">${esc(initials(user?.displayName))}${dot}</span>`;
}

// Group avatar: two overlapping member avatars.
export function groupAvatar(members, size = 40) {
  const a = members[0];
  const b = members[1] || members[0];
  const s = Math.round(size * 0.68);
  return `<span class="av-pair" style="width:${size}px;height:${size}px" aria-hidden="true">
    <span class="a1">${avatar(a, s)}</span><span class="a2">${avatar(b, s)}</span></span>`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLongDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} sec`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}

const DAY = 86400000;
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Short relative stamp for the chat list: 2m, 3h, Mon, Sep 12
export function shortTime(t) {
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (t >= startOfDay(Date.now())) return Math.floor(diff / 3600000) + 'h';
  if (t >= startOfDay(Date.now()) - 6 * DAY) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Divider label inside a conversation: Today · 9:41 AM
export function dividerTime(t) {
  const today = startOfDay(Date.now());
  let day;
  if (t >= today) day = 'Today';
  else if (t >= today - DAY) day = 'Yesterday';
  else if (t >= today - 6 * DAY) day = new Date(t).toLocaleDateString([], { weekday: 'long' });
  else day = new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return `${day} · ${clock(t)}`;
}

export function callTime(t) {
  const today = startOfDay(Date.now());
  if (t >= today) return clock(t);
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function lastSeen(user) {
  if (!user) return '';
  if (user.online) return 'Active now';
  if (!user.lastSeenAt) return 'Offline';
  const diff = Date.now() - user.lastSeenAt;
  if (diff < 60000) return 'Active just now';
  if (diff < 3600000) return `Active ${Math.floor(diff / 60000)}m ago`;
  if (diff < DAY) return `Active ${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7 * DAY) return `Active ${Math.floor(diff / DAY)}d ago`;
  return 'Offline';
}

export function fileSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}

export function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function isEmojiOnly(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 12) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let toastTimer;
export function toast(text, ms = 3200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Sounds are synthesized so there are no audio files to ship.
let actx;
export function audioCtx() {
  if (!actx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    actx = new C();
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

export function beep(freqs, dur = 0.12, gap = 0.04, vol = 0.08) {
  const ctx = audioCtx();
  if (!ctx) return;
  let t = ctx.currentTime;
  for (const f of freqs) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
    t += dur + gap;
  }
}
