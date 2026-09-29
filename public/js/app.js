import { ic, PLAY, PAUSE, LOGO, REACTIONS } from './icons.js';
import {
  esc, avatar, groupAvatar, fmtDuration, fmtLongDuration, shortTime, dividerTime, callTime, clock, lastSeen,
  fileSize, linkify, isEmojiOnly, debounce, uid, toast, beep, audioCtx,
} from './util.js';
import { api, upload, Socket, setUnauthorizedHandler } from './net.js';
import { CallManager } from './calls.js';

const MAX_UPLOAD = 100 * 1024 * 1024;
const GROUP_GAP_MS = 5 * 60 * 1000;
const DIVIDER_GAP_MS = 60 * 60 * 1000;
const root = document.getElementById('app');
const coarse = window.matchMedia('(pointer: coarse)');

const S = {
  me: null,
  convs: new Map(),
  view: 'chats', // chats | calls
  filter: 'all',
  search: '',
  activeId: null,
  threads: new Map(), // conversationId -> { list, hasMore, loading, loaded }
  typing: new Map(), // conversationId -> Map(userId -> timer)
  replyTo: null,
  infoOpen: window.innerWidth >= 1200,
  infoTab: 'media',
  shared: null,
  calls: null,
  drafts: new Map(),
  pending: [],
  started: false,
};

const socket = new Socket();
let calls;

// ---------------------------------------------------------------------------
// Helpers about people and chats
// ---------------------------------------------------------------------------

function others(conv) {
  return conv.members.filter((m) => m.id !== S.me.id);
}
function firstName(u) {
  return (u?.displayName || 'Someone').split(' ')[0];
}
function convTitle(conv) {
  if (!conv) return '';
  if (conv.title) return conv.title;
  const o = others(conv);
  if (!o.length) return S.me.displayName + ' (you)';
  if (!conv.isGroup) return o[0].displayName;
  return o.map(firstName).join(', ');
}
function convAvatar(conv, size) {
  const o = others(conv);
  if (conv.isGroup) return groupAvatar(o.length ? o : conv.members, size);
  const u = o[0] || S.me;
  return avatar(u, size, { online: u.online && u.id !== S.me.id });
}
function convStatus(conv) {
  if (conv.isGroup) {
    const online = others(conv).filter((u) => u.online).length;
    return `${conv.members.length} members${online ? ` · ${online} active` : ''}`;
  }
  return lastSeen(others(conv)[0]);
}
function userById(id) {
  if (S.me && id === S.me.id) return S.me;
  for (const c of S.convs.values()) {
    const u = c.members.find((m) => m.id === id);
    if (u) return u;
  }
  return null;
}
function sortedConvs() {
  const t = (c) => (c.lastMessage ? c.lastMessage.createdAt : c.updatedAt);
  return [...S.convs.values()].sort((a, b) => t(b) - t(a));
}
function thread(cid) {
  let t = S.threads.get(cid);
  if (!t) {
    t = { list: [], hasMore: true, loading: false, loaded: false };
    S.threads.set(cid, t);
  }
  return t;
}
function findMessage(id) {
  for (const t of S.threads.values()) {
    const m = t.list.find((x) => x.id === id);
    if (m) return m;
  }
  return S.pending.find((p) => p.clientId === id) || null;
}
function totalUnread() {
  let n = 0;
  for (const c of S.convs.values()) if (!c.muted && c.unread) n += 1;
  return n;
}
function typingUsers(cid) {
  const m = S.typing.get(cid);
  return m ? [...m.keys()].map(userById).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Boot and auth
// ---------------------------------------------------------------------------

setUnauthorizedHandler(() => {
  if (S.me) signOutLocal();
});

async function boot() {
  let user = null;
  try {
    ({ user } = await api('GET', '/api/me'));
  } catch {}
  if (!user) return renderAuth('login');
  S.me = user;
  await start();
}

function renderAuth(mode) {
  document.title = 'Parley';
  root.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="auth-brand">${LOGO}<h1 class="h-display">Parley</h1></div>
        <p class="auth-lede">Chat, share photos and voice messages, and call the people you care about.</p>
        <div class="auth-tabs" role="tablist">
          <button role="tab" aria-selected="${mode === 'login'}" data-mode="login">Sign in</button>
          <button role="tab" aria-selected="${mode === 'signup'}" data-mode="signup">Create account</button>
        </div>
        <form novalidate>
          ${mode === 'signup' ? `
          <label>Your name<input class="input" name="displayName" autocomplete="name" required maxlength="40" placeholder="Mika Reyes"></label>` : ''}
          <label>Username${mode === 'signup' ? ' <span class="hint">Friends find you by this</span>' : ''}
            <input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="24" placeholder="mika.reyes"></label>
          <label>Password${mode === 'signup' ? ' <span class="hint">At least 8 characters</span>' : ''}
            <input class="input" name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
          <p class="error" role="alert"></p>
          <button class="btn primary block" type="submit">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        </form>
      </div>
    </div>`;
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  const form = root.querySelector('form');
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const err = form.querySelector('.error');
    const data = Object.fromEntries(new FormData(form));
    btn.disabled = true;
    err.textContent = '';
    try {
      const { user } = await api('POST', mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', data);
      S.me = user;
      audioCtx();
      await start();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

async function start() {
  if (!calls) {
    calls = new CallManager({
      socket,
      me: () => S.me,
      conv: (id) => S.convs.get(id),
      title: convTitle,
      userById: (id) => userById(id) || { id, displayName: 'Guest', color: 0 },
      onChange: () => renderThreadHead(),
    });
  }
  S.started = true;
  renderShell();
  socket.connect();
  await loadConversations();
  applyRoute();
}

function signOutLocal() {
  socket.disconnect();
  if (calls) calls.cleanup();
  Object.assign(S, {
    me: null, convs: new Map(), threads: new Map(), typing: new Map(), activeId: null, pending: [], calls: null, shared: null, replyTo: null,
  });
  history.replaceState(null, '', '/');
  renderAuth('login');
}

async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  signOutLocal();
}

async function loadConversations() {
  try {
    const { conversations } = await api('GET', '/api/conversations');
    S.convs = new Map(conversations.map((c) => [c.id, c]));
  } catch (err) {
    toast(err.message);
  }
  renderList();
  renderRailBadges();
  updateTitle();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function navigate(path, replace = false) {
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  applyRoute();
}

function applyRoute() {
  if (!S.me) return;
  const p = location.pathname;
  let m;
  if ((m = /^\/c\/(\d+)$/.exec(p))) {
    const id = Number(m[1]);
    if (!S.convs.has(id)) {
      history.replaceState(null, '', '/');
      return applyRoute();
    }
    if (S.view !== 'chats') setView('chats');
    openConversation(id);
  } else if (p === '/calls') {
    setView('calls');
    closeConversation();
  } else {
    if (S.view !== 'chats') setView('chats');
    closeConversation();
  }
}
window.addEventListener('popstate', applyRoute);

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderShell() {
  root.innerHTML = `
    <div class="shell">
      <nav class="rail" aria-label="Main">
        ${LOGO}
        <a class="rail-btn" href="/" data-link data-tab="chats" aria-label="Chats">${ic('chat', 24)}<span class="badge" hidden></span></a>
        <a class="rail-btn" href="/calls" data-link data-tab="calls" aria-label="Calls">${ic('phone', 22)}</a>
        <span class="spacer"></span>
        <button class="rail-btn me-btn" data-action="me-menu" aria-label="Your profile and settings"></button>
      </nav>
      <section class="sidebar" id="sidebar"></section>
      <main class="thread" id="thread"></main>
      <aside class="info" id="info" aria-label="Chat details" hidden></aside>
    </div>`;
  renderSidebar();
  renderThread();
  renderMeButtons();
}

function shellEl() {
  return root.querySelector('.shell');
}

function renderMeButtons() {
  root.querySelectorAll('.me-btn').forEach((b) => { b.innerHTML = avatar(S.me, 36); });
}

function renderRailBadges() {
  const n = totalUnread();
  root.querySelectorAll('[data-tab="chats"] .badge').forEach((b) => {
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  });
  root.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === S.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function updateTitle() {
  const n = totalUnread();
  document.title = n ? `(${n}) Parley` : 'Parley';
}

function setView(view) {
  S.view = view;
  renderSidebar();
  renderRailBadges();
  if (view === 'calls') loadCalls();
}

function tabbar() {
  const n = totalUnread();
  return `<nav class="tabbar" aria-label="Main">
    <a class="tab" href="/" data-link data-tab="chats">${ic('chat', 24)}Chats<span class="badge" ${n ? '' : 'hidden'}>${n}</span></a>
    <a class="tab" href="/calls" data-link data-tab="calls">${ic('phone', 22)}Calls</a>
    <button class="tab" data-action="new-chat">${ic('edit', 22)}New</button>
  </nav>`;
}

function renderSidebar() {
  const el = document.getElementById('sidebar');
  if (!el) return;
  if (S.view === 'calls') {
    el.innerHTML = `
      <div class="side-head"><h1 class="h-display">Calls</h1>
        <button class="me-btn" data-action="me-menu" aria-label="Your profile and settings"></button></div>
      <div class="list" id="list"></div>
      ${tabbar()}`;
  } else {
    el.innerHTML = `
      <div class="side-head"><h1 class="h-display">Chats</h1>
        <button class="icon-btn soft" data-action="new-chat" aria-label="New message">${ic('edit', 20)}</button>
        <button class="me-btn" data-action="me-menu" aria-label="Your profile and settings"></button></div>
      <div class="side-search"><label class="sr" for="search">Search chats</label>
        <div class="field-wrap">${ic('search', 18)}<input id="search" class="input" type="search" placeholder="Search chats" autocomplete="off" value="${esc(S.search)}"></div></div>
      <div class="side-chips" role="group" aria-label="Filter chats">
        <button class="chip" data-filter="all" aria-pressed="${S.filter === 'all'}">All</button>
        <button class="chip" data-filter="unread" aria-pressed="${S.filter === 'unread'}">Unread</button>
        <button class="chip" data-filter="groups" aria-pressed="${S.filter === 'groups'}">Groups</button>
      </div>
      <div class="list" id="list"></div>
      ${tabbar()}`;
    el.querySelector('#search').addEventListener('input', (e) => {
      S.search = e.target.value;
      renderList();
    });
  }
  renderMeButtons();
  renderRailBadges();
  renderList();
}

function renderList() {
  const list = document.getElementById('list');
  if (!list || !S.me) return;
  if (S.view === 'calls') return renderCallsList(list);
  const q = S.search.trim().toLowerCase();
  let convs = sortedConvs();
  if (S.filter === 'unread') convs = convs.filter((c) => c.unread);
  if (S.filter === 'groups') convs = convs.filter((c) => c.isGroup);
  if (q) convs = convs.filter((c) => convTitle(c).toLowerCase().includes(q) || c.members.some((m) => m.username.includes(q)));
  if (!convs.length) {
    list.innerHTML = S.convs.size
      ? `<div class="empty"><p>No chats match.</p></div>`
      : `<div class="empty"><h2 class="h-display">No chats yet</h2><p>Find a friend by their username and say hi.</p>
         <button class="btn primary" data-action="new-chat">${ic('edit', 18)}Start a chat</button></div>`;
    return;
  }
  list.innerHTML = convs.map(rowHtml).join('');
}

function rowHtml(conv) {
  const unread = conv.unread > 0;
  const current = conv.id === S.activeId;
  return `<a class="row${unread ? ' unread' : ''}" href="/c/${conv.id}" data-link ${current ? 'aria-current="true"' : ''}>
    ${convAvatar(conv, 52)}
    <span class="row-main">
      <span class="row-top"><span class="row-name">${esc(convTitle(conv))}</span>
        ${conv.muted ? `<span class="mute-ic" title="Muted">${ic('bellOff', 14)}</span>` : ''}
        <span class="row-time">${shortTime(conv.lastMessage ? conv.lastMessage.createdAt : conv.updatedAt)}</span></span>
      <span class="row-bottom"><span class="row-preview">${previewHtml(conv)}</span>
        ${unread ? `<span class="badge">${conv.unread > 99 ? '99+' : conv.unread}</span>` : ''}</span>
    </span></a>`;
}

function previewHtml(conv) {
  const typers = typingUsers(conv.id);
  if (typers.length) {
    return `<span style="color:var(--accent-text)">${esc(conv.isGroup ? typers.map(firstName).join(', ') + ' typing…' : 'Typing…')}</span>`;
  }
  const m = conv.lastMessage;
  if (!m) return `<span>${conv.isGroup ? 'Group created' : 'Say hi'}</span>`;
  const mine = m.senderId === S.me.id;
  const who = m.kind === 'system' || m.kind === 'call' ? '' : mine ? 'You: ' : conv.isGroup ? firstName(userById(m.senderId)) + ': ' : '';
  let icon = '';
  let text = '';
  switch (m.kind) {
    case 'text': text = m.body; break;
    case 'image': icon = 'image'; text = 'Photo'; break;
    case 'video': icon = 'video'; text = 'Video'; break;
    case 'audio': icon = 'mic'; text = 'Voice message' + (m.media?.duration ? ' · ' + fmtDuration(m.media.duration) : ''); break;
    case 'file': icon = 'file'; text = m.media?.name || 'File'; break;
    case 'deleted': text = mine ? 'You unsent a message' : `${firstName(userById(m.senderId))} unsent a message`; break;
    case 'call': {
      const c = m.call || {};
      icon = c.callKind === 'video' ? 'video' : 'phone';
      text = c.missed ? (mine ? 'No answer' : `Missed ${c.callKind === 'video' ? 'video' : 'audio'} call`) : `${c.callKind === 'video' ? 'Video' : 'Audio'} call · ${fmtLongDuration(c.duration)}`;
      break;
    }
    default: text = m.body || '';
  }
  return `${icon ? ic(icon, 15) : ''}<span>${esc(who + text)}</span>`;
}

// ---------------------------------------------------------------------------
// Calls tab
// ---------------------------------------------------------------------------

async function loadCalls() {
  try {
    const { calls: list } = await api('GET', '/api/calls');
    S.calls = list;
  } catch (err) {
    toast(err.message);
    S.calls = S.calls || [];
  }
  if (S.view === 'calls') renderList();
}

function renderCallsList(list) {
  if (!S.calls) {
    list.innerHTML = '<div class="empty"><div class="spinner" role="status" aria-label="Loading"></div></div>';
    return;
  }
  const rows = S.calls.filter((c) => S.convs.has(c.conversationId));
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><h2 class="h-display">No calls yet</h2><p>Open a chat and tap the phone or camera to call.</p></div>`;
    return;
  }
  list.innerHTML = rows.map((c) => {
    const conv = S.convs.get(c.conversationId);
    const missed = c.direction === 'missed';
    const kindLabel = c.kind === 'video' ? 'video' : 'audio';
    let label;
    if (missed) label = `Missed ${kindLabel}`;
    else if (c.direction === 'outgoing') label = c.answered ? `Outgoing ${kindLabel} · ${fmtLongDuration(c.duration)}` : `Outgoing ${kindLabel} · No answer`;
    else label = `Incoming ${kindLabel} · ${fmtLongDuration(c.duration)}`;
    return `<div class="row${missed ? ' missed' : ''}">
      <a href="/c/${conv.id}" data-link style="display:contents;color:inherit;text-decoration:none">
        ${convAvatar(conv, 52)}
        <span class="row-main"><span class="row-top"><span class="row-name">${esc(convTitle(conv))}</span><span class="row-time">${callTime(c.startedAt)}</span></span>
        <span class="row-bottom"><span class="row-preview">${ic(c.direction === 'outgoing' ? 'outArrow' : 'inArrow', 14)}<span>${esc(label)}</span></span></span></span>
      </a>
      <span class="row-actions">
        <button class="icon-btn accent" data-action="call" data-cid="${conv.id}" data-kind="audio" aria-label="Audio call ${esc(convTitle(conv))}">${ic('phone', 20)}</button>
        <button class="icon-btn accent" data-action="call" data-cid="${conv.id}" data-kind="video" aria-label="Video call ${esc(convTitle(conv))}">${ic('video', 22)}</button>
      </span></div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------

function closeConversation() {
  if (S.activeId) saveDraft();
  S.activeId = null;
  S.replyTo = null;
  shellEl()?.classList.remove('thread-open');
  renderThread();
  renderInfo();
  renderList();
}

async function openConversation(cid) {
  if (S.activeId === cid) return;
  if (S.activeId) saveDraft();
  S.activeId = cid;
  S.replyTo = null;
  S.shared = null;
  shellEl()?.classList.add('thread-open');
  renderThread();
  renderInfo();
  renderList();
  const t = thread(cid);
  if (!t.loaded) await loadMessages(cid);
  else syncMessages({ stick: true });
  markRead();
  if (!coarse.matches) document.getElementById('composer-input')?.focus();
}

async function loadMessages(cid, older = false) {
  const t = thread(cid);
  if (t.loading) return;
  t.loading = true;
  if (S.activeId === cid) syncMessages();
  try {
    const before = older && t.list.length ? t.list[0].id : '';
    const data = await api('GET', `/api/conversations/${cid}/messages?limit=40${before ? '&before=' + before : ''}`);
    const ids = new Set(t.list.map((m) => m.id));
    const incoming = data.messages.filter((m) => !ids.has(m.id));
    t.list = older ? [...incoming, ...t.list] : mergeById(t.list, data.messages);
    t.hasMore = data.hasMore;
    t.loaded = true;
  } catch (err) {
    toast(err.message);
  }
  t.loading = false;
  if (S.activeId === cid) syncMessages(older ? { keepOffset: true } : { stick: true });
}

function mergeById(a, b) {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.id - y.id);
}

function renderThread() {
  const el = document.getElementById('thread');
  if (!el) return;
  const conv = S.convs.get(S.activeId);
  if (!conv) {
    el.innerHTML = `<div class="thread-empty">${LOGO}<h2 class="h-display">Welcome, ${esc(firstName(S.me))}</h2>
      <p>Pick a chat on the left, or start a new one.</p>
      <button class="btn primary" data-action="new-chat">${ic('edit', 18)}New message</button></div>`;
    return;
  }
  el.innerHTML = `
    <header class="thread-head" id="thread-head"></header>
    <div id="call-banner"></div>
    <div class="messages" id="messages" aria-live="polite" aria-relevant="additions">
      <div class="top-pad"></div>
      <div id="msg-list"></div>
    </div>
    <button class="jump" id="jump" hidden aria-label="Jump to latest">${ic('down', 22)}</button>
    <div class="composer" id="composer"></div>`;
  renderThreadHead();
  renderComposer();
  const box = el.querySelector('#messages');
  box.addEventListener('scroll', onMessagesScroll, { passive: true });
  box.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG' && box.dataset.stick === '1') box.scrollTop = box.scrollHeight;
  }, true);
  el.querySelector('#jump').addEventListener('click', () => {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  });
  setupDrop(el);
  syncMessages({ stick: true });
}

function renderThreadHead() {
  const head = document.getElementById('thread-head');
  const conv = S.convs.get(S.activeId);
  if (!head || !conv) return;
  const inCall = calls && calls.inCall();
  head.innerHTML = `
    <a class="icon-btn back" href="/" data-link aria-label="Back to chats">${ic('back', 24)}</a>
    <button class="who" data-action="toggle-info" aria-label="Chat details for ${esc(convTitle(conv))}">
      ${convAvatar(conv, 42)}
      <span class="who-text"><span class="who-name">${esc(convTitle(conv))}</span><span class="who-status">${esc(convStatus(conv))}</span></span>
    </button>
    <button class="icon-btn accent" data-action="call" data-kind="audio" aria-label="Start audio call" ${inCall ? 'disabled' : ''}>${ic('phone', 21)}</button>
    <button class="icon-btn accent" data-action="call" data-kind="video" aria-label="Start video call" ${inCall ? 'disabled' : ''}>${ic('video', 24)}</button>
    <button class="icon-btn accent" data-action="toggle-info" aria-label="Chat details" aria-pressed="${S.infoOpen}">${ic('info', 22)}</button>`;
  const banner = document.getElementById('call-banner');
  if (banner) {
    const ac = conv.activeCall;
    const mine = inCall && calls.s?.call?.id === ac?.id;
    banner.innerHTML = ac && !mine && ac.participants?.length
      ? `<div class="call-banner">${ic(ac.kind === 'video' ? 'video' : 'phone', 18)}<span>${ac.kind === 'video' ? 'Video' : 'Audio'} call in progress</span>
         <button class="btn primary" data-action="join-call">Join</button></div>`
      : '';
  }
}

function renderComposer() {
  const el = document.getElementById('composer');
  if (!el) return;
  const draft = S.drafts.get(S.activeId) || '';
  el.innerHTML = `
    <div class="reply-bar" id="reply-bar" hidden></div>
    <div class="comp-row" id="comp-row">
      <button class="icon-btn" data-action="attach-menu" aria-label="Attach" aria-haspopup="menu">${ic('plusCircle', 24)}</button>
      <button class="icon-btn" data-action="pick-media" aria-label="Send photos or videos">${ic('image', 22)}</button>
      <div class="comp-field">
        <label for="composer-input" class="sr">Message</label>
        <textarea id="composer-input" rows="1" placeholder="Message" enterkeyhint="send" maxlength="5000"></textarea>
      </div>
      <button class="icon-btn send-btn" data-action="send" aria-label="Send" hidden>${ic('send', 20)}</button>
      <button class="icon-btn" data-action="record" aria-label="Record a voice message">${ic('mic', 24)}</button>
    </div>
    <div class="rec-row" id="rec-row" hidden>
      <button class="icon-btn" data-action="rec-cancel" aria-label="Delete recording" style="color:var(--muted)">${ic('trash', 22)}</button>
      <div class="rec-pill" role="status" aria-label="Recording voice message"><span class="rec-dot"></span><span class="rec-time">0:00</span><span class="rec-bars" aria-hidden="true"></span></div>
      <button class="icon-btn send-btn" data-action="rec-send" aria-label="Send voice message">${ic('send', 20)}</button>
    </div>`;
  const ta = el.querySelector('textarea');
  ta.value = draft;
  autosize(ta);
  toggleSendButton();
  ta.addEventListener('input', () => {
    autosize(ta);
    toggleSendButton();
    typingPing();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse.matches) {
      e.preventDefault();
      sendText();
    }
    if (e.key === 'Escape' && S.replyTo) setReply(null);
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      sendFiles(files);
    }
  });
  renderReplyBar();
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

function toggleSendButton() {
  const ta = document.getElementById('composer-input');
  const has = !!ta && ta.value.trim().length > 0;
  const el = document.getElementById('comp-row');
  if (!el) return;
  el.querySelector('[data-action=send]').hidden = !has;
  el.querySelector('[data-action=record]').hidden = has;
}

function saveDraft() {
  const ta = document.getElementById('composer-input');
  if (ta && S.activeId) S.drafts.set(S.activeId, ta.value);
}

function setReply(m) {
  S.replyTo = m;
  renderReplyBar();
  if (m) document.getElementById('composer-input')?.focus();
}

function renderReplyBar() {
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  const m = S.replyTo;
  bar.hidden = !m;
  if (!m) {
    bar.innerHTML = '';
    return;
  }
  const who = m.senderId === S.me.id ? 'yourself' : userById(m.senderId)?.displayName || 'them';
  bar.innerHTML = `${ic('reply', 18)}<div><b>Replying to ${esc(who)}</b><span>${esc(messagePreview(m))}</span></div>
    <button class="icon-btn" data-action="cancel-reply" aria-label="Cancel reply">${ic('x', 18)}</button>`;
}

function messagePreview(m) {
  switch (m.kind) {
    case 'text': return m.body;
    case 'image': return 'Photo';
    case 'video': return 'Video';
    case 'audio': return 'Voice message';
    case 'file': return m.media?.name || 'File';
    default: return m.body || '';
  }
}

// ----- message list rendering (keyed, so media players survive updates) -----

function syncMessages(opts = {}) {
  const cid = S.activeId;
  const box = document.getElementById('messages');
  const listEl = document.getElementById('msg-list');
  if (!box || !listEl || !cid) return;
  const t = thread(cid);
  const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const wasNearBottom = fromBottom < 120;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;

  const conv = S.convs.get(cid);
  const items = [];
  if (t.loading && !t.list.length) {
    items.push({ key: 'loading', html: '<div class="empty"><div class="spinner" role="status" aria-label="Loading messages"></div></div>' });
  } else if (t.hasMore && t.loaded) {
    items.push({ key: 'more', html: `<button class="btn ghost load-more" data-action="load-older">${t.loading ? 'Loading…' : 'Load earlier messages'}</button>` });
  } else if (t.loaded) {
    items.push({ key: 'intro', html: introHtml(conv) });
  }

  const all = [...t.list, ...S.pending.filter((p) => p.conversationId === cid)];
  const lastMineIdx = findLastIndex(all, (m) => m.senderId === S.me.id && !m.pending && m.kind !== 'call' && m.kind !== 'system');
  const lastPendingIdx = findLastIndex(all, (m) => m.pending);
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    const prev = all[i - 1];
    const next = all[i + 1];
    const needDivider = !prev || m.createdAt - prev.createdAt > DIVIDER_GAP_MS;
    if (needDivider) items.push({ key: 'd' + (m.id ?? m.clientId), html: `<div class="divider">${esc(dividerTime(m.createdAt))}</div>` });
    const groupable = (a, b) => a && b && a.senderId === b.senderId && !isEvent(a) && !isEvent(b) && Math.abs(b.createdAt - a.createdAt) < GROUP_GAP_MS;
    const nextDivider = next && next.createdAt - m.createdAt > DIVIDER_GAP_MS;
    const first = needDivider || !groupable(prev, m);
    const last = !next || nextDivider || !groupable(m, next);
    let status = '';
    if (i === lastMineIdx && i > lastPendingIdx) status = statusFor(m, conv);
    if (m.pending) status = m.failed
      ? `<div class="status failed">Not sent · <button class="retry" data-action="retry" data-id="${m.clientId}">Retry</button></div>`
      : `<div class="status">Sending…</div>`;
    items.push({ key: 'm' + (m.id ?? m.clientId), html: msgHtml(m, { first, last, status, conv }) });
  }
  const typers = typingUsers(cid);
  if (typers.length) {
    items.push({ key: 'typing', html: `<div class="typing-row">${avatar(typers[0], 30)}<div class="typing" role="status" aria-label="${esc(typers.map(firstName).join(', '))} typing"><span></span><span></span><span></span></div></div>` });
  }

  // Keyed reconcile: keep nodes whose html didn't change.
  const existing = new Map();
  for (const node of [...listEl.children]) existing.set(node.dataset.key, node);
  let cursor = listEl.firstChild;
  for (const item of items) {
    let node = existing.get(item.key);
    existing.delete(item.key);
    if (node && node._html !== item.html) {
      const fresh = createNode(item);
      node.replaceWith(fresh);
      if (cursor === node) cursor = fresh;
      node = fresh;
    }
    if (!node) node = createNode(item);
    if (node === cursor) cursor = cursor.nextSibling;
    else listEl.insertBefore(node, cursor);
  }
  for (const node of existing.values()) node.remove();
  applyVoiceState();

  if (opts.keepOffset) {
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  } else if (opts.stick || wasNearBottom) {
    box.scrollTop = box.scrollHeight;
  }
  box.dataset.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120 ? '1' : '0';
}

function createNode(item) {
  const wrap = document.createElement('div');
  wrap.dataset.key = item.key;
  wrap.innerHTML = item.html;
  wrap._html = item.html;
  return wrap;
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function isEvent(m) {
  return m.kind === 'system' || m.kind === 'call';
}

function introHtml(conv) {
  if (!conv) return '';
  return `<div class="empty" style="flex:none;padding:28px 16px 12px">${convAvatar(conv, 72)}
    <h2 class="h-display" style="font-size:20px">${esc(convTitle(conv))}</h2>
    <p>${conv.isGroup ? `${conv.members.length} members` : `@${esc(others(conv)[0]?.username || '')} · You’re connected on Parley`}</p></div>`;
}

function statusFor(m, conv) {
  if (!conv) return '';
  const readers = others(conv).filter((u) => (u.lastReadId || 0) >= m.id);
  if (!readers.length) return `<div class="status">Sent</div>`;
  if (!conv.isGroup) return `<div class="status">Seen ${avatar(readers[0], 14)}</div>`;
  const names = readers.slice(0, 3).map(firstName).join(', ') + (readers.length > 3 ? ` +${readers.length - 3}` : '');
  return `<div class="status">Seen by ${esc(names)}</div>`;
}

function msgHtml(m, f) {
  if (m.kind === 'system') return `<div class="sys">${esc(m.body)}</div>`;
  if (m.kind === 'call') return callMsgHtml(m);
  const mine = m.senderId === S.me.id;
  const sender = userById(m.senderId) || { displayName: 'Former member', color: 0 };
  const cls = `msg ${mine ? 'mine' : 'theirs'}${f.first ? ' first' : ''}${f.last ? ' last' : ''}`;
  const head = !mine && f.conv?.isGroup && f.first ? `<div class="sender">${esc(sender.displayName)}</div>` : '';
  const av = mine ? '' : `<div class="msg-av">${f.last ? avatar(sender, 30) : ''}</div>`;
  let quote = '';
  if (m.replyTo && !m.deleted) {
    const target = m.replyTo.senderId === S.me.id ? 'you' : m.replyTo.senderId === m.senderId ? (mine ? 'yourself' : 'themself') : firstName(userById(m.replyTo.senderId));
    const who = mine ? `You replied to ${target}` : `${firstName(sender)} replied to ${target}`;
    quote = `<button class="quote" data-action="jump-to" data-id="${m.replyTo.id}"><b>${ic('reply', 12)}${esc(who)}</b><span>${esc(m.replyTo.preview)}</span></button>`;
  }
  let content = '';
  const url = m.media?.url;
  switch (m.kind) {
    case 'text':
      content = `<div class="bubble${isEmojiOnly(m.body) ? ' big' : ''}">${linkify(m.body)}</div>`;
      break;
    case 'image':
      content = m.pending
        ? `<div class="media img pending" data-pid="${m.clientId}"><img src="${url}" alt=""><div class="progress"><span style="width:${Math.round((m.progress || 0) * 100)}%"></span></div></div>`
        : `<button class="media img" data-action="view" data-id="${m.id}" aria-label="Open photo"><img src="${url}" alt="Photo from ${esc(sender.displayName)}" loading="lazy"></button>`;
      break;
    case 'video':
      content = m.pending
        ? `<div class="media pending" data-pid="${m.clientId}"><video src="${url}" muted playsinline preload="metadata"></video><div class="progress"><span style="width:${Math.round((m.progress || 0) * 100)}%"></span></div></div>`
        : `<div class="media"><video src="${url}#t=0.1" controls playsinline preload="metadata"></video></div>`;
      break;
    case 'audio':
      content = voiceHtml(m);
      break;
    case 'file':
      content = m.pending
        ? `<div class="file" data-pid="${m.clientId}"><span class="file-ic">${ic('file', 20)}</span><span class="file-meta"><span class="file-name">${esc(m.media.name)}</span><span class="file-size prog-label">Uploading ${Math.round((m.progress || 0) * 100)}%</span></span></div>`
        : `<a class="file" href="${url}?download=1" download="${esc(m.media.name)}"><span class="file-ic">${ic('file', 20)}</span><span class="file-meta"><span class="file-name">${esc(m.media.name)}</span><span class="file-size">${fileSize(m.media.size)} · Download</span></span></a>`;
      break;
    case 'deleted':
      content = `<div class="bubble deleted">${mine ? 'You unsent a message' : `${esc(firstName(sender))} unsent a message`}</div>`;
      break;
    default:
      content = `<div class="bubble">${esc(m.body || '')}</div>`;
  }
  if (m.body && (m.kind === 'image' || m.kind === 'video')) content += `<div class="bubble caption">${linkify(m.body)}</div>`;
  let reacts = '';
  if (m.reactions?.length) {
    const keys = [...new Set(m.reactions.map((r) => r.key))].slice(0, 3);
    reacts = `<button class="reacts" data-action="reactors" data-id="${m.id}" aria-label="${m.reactions.length} reaction${m.reactions.length > 1 ? 's' : ''}">
      ${keys.map((k) => ic(k, 15, k === 'heart' ? 'filled' : '')).join('')}${m.reactions.length > 1 ? `<b>${m.reactions.length}</b>` : ''}</button>`;
  }
  const more = m.pending || m.deleted ? '' : `<button class="more-btn" data-action="menu" data-id="${m.id}" aria-label="Message actions" aria-haspopup="menu">${ic('more', 20)}</button>`;
  return `<div class="${cls}" data-mid="${m.id ?? ''}">${head}<div class="msg-line">${av}<div class="msg-body" title="${esc(clock(m.createdAt))}">${quote}${content}${reacts}</div>${more}</div>${f.status || ''}</div>`;
}

function callMsgHtml(m) {
  const c = m.call || {};
  const video = c.callKind === 'video';
  const mine = m.senderId === S.me.id;
  const title = c.missed
    ? (mine ? `${video ? 'Video' : 'Audio'} call · No answer` : `Missed ${video ? 'video' : 'audio'} call`)
    : `${video ? 'Video' : 'Audio'} call`;
  const sub = c.missed ? clock(m.createdAt) : `${fmtLongDuration(c.duration)} · ${clock(m.createdAt)}`;
  return `<div class="callmsg${c.missed && !mine ? ' missed' : ''}"><span class="ic">${ic(video ? 'video' : 'phone', 18)}</span>
    <div class="callmsg-text"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
    <button class="btn ghost" data-action="call" data-kind="${video ? 'video' : 'audio'}">Call back</button></div>`;
}

function waveBars(m, n) {
  let w = m.media?.waveform;
  if (!w || !w.length) {
    // Stable pseudo-waveform for voice notes without one.
    let seed = (m.id || 7) * 9301;
    w = Array.from({ length: n }, () => {
      seed = (seed * 9301 + 49297) % 233280;
      return 25 + (seed / 233280) * 70;
    });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = w[Math.floor((i / n) * w.length)] || 0;
    out.push(Math.round(4 + (Math.max(8, v) / 100) * 22));
  }
  return out;
}

function voiceHtml(m) {
  const id = m.id ?? m.clientId;
  const bars = waveBars(m, 32);
  const dur = m.media?.duration || 0;
  if (m.pending) {
    return `<div class="voice" data-pid="${m.clientId}"><span class="vplay">${PLAY}</span>
      <span class="bars">${bars.map((h) => `<span style="height:${h}px"></span>`).join('')}</span>
      <span class="vtime prog-label">${Math.round((m.progress || 0) * 100)}%</span></div>`;
  }
  return `<div class="voice" data-voice="${id}" data-dur="${dur}">
    <button class="vplay" data-action="play" data-id="${id}" aria-label="Play voice message, ${fmtDuration(dur)}">${PLAY}</button>
    <span class="bars" data-action="seek" data-id="${id}">${bars.map((h) => `<span style="height:${h}px"></span>`).join('')}</span>
    <span class="vtime">${fmtDuration(dur)}</span></div>`;
}

function onMessagesScroll() {
  const box = document.getElementById('messages');
  if (!box) return;
  const fromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  box.dataset.stick = fromBottom < 120 ? '1' : '0';
  const jump = document.getElementById('jump');
  if (jump) jump.hidden = fromBottom < 400;
  const t = thread(S.activeId);
  if (box.scrollTop < 150 && t.hasMore && !t.loading && t.loaded) loadMessages(S.activeId, true);
  if (fromBottom < 120) markRead();
}

// ----- voice note playback -----

const player = { audio: new Audio(), id: null, raf: 0 };
player.audio.preload = 'none';
['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata'].forEach((ev) => player.audio.addEventListener(ev, () => {
  if (ev === 'ended') player.audio.currentTime = 0;
  applyVoiceState();
}));

function voiceDuration(el) {
  const d = player.audio.duration;
  return Number.isFinite(d) && d > 0 ? d : Number(el?.dataset.dur) || 0;
}

function applyVoiceState() {
  document.querySelectorAll('.voice[data-voice]').forEach((el) => {
    const id = el.dataset.voice;
    const active = String(player.id) === id;
    const playing = active && !player.audio.paused;
    const dur = active ? voiceDuration(el) : Number(el.dataset.dur) || 0;
    const t = active ? player.audio.currentTime : 0;
    const frac = dur ? t / dur : 0;
    const btn = el.querySelector('.vplay');
    const want = playing ? 'pause' : 'play';
    if (btn.dataset.state !== want) {
      btn.dataset.state = want;
      btn.innerHTML = playing ? PAUSE : PLAY;
      btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} voice message`);
    }
    const bars = el.querySelectorAll('.bars span');
    bars.forEach((b, i) => b.classList.toggle('on', active && (i + 0.5) / bars.length <= frac));
    el.querySelector('.vtime').textContent = fmtDuration(active && (playing || t > 0) ? t : dur);
  });
  cancelAnimationFrame(player.raf);
  if (!player.audio.paused) player.raf = requestAnimationFrame(applyVoiceState);
}

function playVoice(id, seekFrac) {
  const m = findMessage(Number(id));
  if (!m?.media) return;
  if (String(player.id) !== String(id)) {
    player.audio.pause();
    player.id = m.id;
    player.audio.src = m.media.url;
    player.audio.load();
  } else if (seekFrac == null) {
    if (!player.audio.paused) {
      player.audio.pause();
      return;
    }
  }
  if (seekFrac != null) {
    const el = document.querySelector(`.voice[data-voice="${m.id}"]`);
    const setPos = () => {
      const d = voiceDuration(el);
      if (d) player.audio.currentTime = Math.min(d * seekFrac, d - 0.05);
    };
    if (player.audio.readyState >= 1) setPos();
    else player.audio.addEventListener('loadedmetadata', setPos, { once: true });
  }
  player.audio.play().catch(() => toast('Could not play this voice message.'));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendText() {
  const ta = document.getElementById('composer-input');
  const cid = S.activeId;
  if (!ta || !cid) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  autosize(ta);
  toggleSendButton();
  S.drafts.delete(cid);
  stopTyping();
  const reply = S.replyTo;
  setReply(null);
  const p = {
    pending: true,
    clientId: uid(),
    id: null,
    conversationId: cid,
    senderId: S.me.id,
    kind: 'text',
    body: text,
    replyTo: reply ? { id: reply.id, senderId: reply.senderId, preview: messagePreview(reply) } : null,
    reactions: [],
    createdAt: Date.now(),
  };
  S.pending.push(p);
  syncMessages({ stick: true });
  await postText(p);
}

async function postText(p) {
  try {
    const { message } = await api('POST', `/api/conversations/${p.conversationId}/messages`, {
      body: p.body,
      clientId: p.clientId,
      replyToId: p.replyTo?.id,
    });
    resolvePending(p.clientId, message);
  } catch (err) {
    p.failed = true;
    if (S.activeId === p.conversationId) syncMessages();
    toast(err.message);
  }
}

function kindOf(mime, voice) {
  if (voice || mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  return 'file';
}

function sendFiles(files) {
  const cid = S.activeId;
  if (!cid) return;
  for (const f of files) {
    if (f.size > MAX_UPLOAD) {
      toast(`${f.name} is larger than 100 MB.`);
      continue;
    }
    if (!f.size) continue;
    queueUpload(cid, f, { name: f.name });
  }
}

function queueUpload(cid, blob, opts = {}) {
  const mime = blob.type || 'application/octet-stream';
  const reply = S.replyTo;
  setReply(null);
  const p = {
    pending: true,
    clientId: uid(),
    id: null,
    conversationId: cid,
    senderId: S.me.id,
    kind: kindOf(mime, opts.voice),
    body: null,
    replyTo: reply ? { id: reply.id, senderId: reply.senderId, preview: messagePreview(reply) } : null,
    reactions: [],
    createdAt: Date.now(),
    progress: 0,
    blob,
    opts,
    media: { url: URL.createObjectURL(blob), name: opts.name || blob.name || 'file', mime, size: blob.size, duration: opts.duration, waveform: opts.waveform },
  };
  S.pending.push(p);
  if (S.activeId === cid) syncMessages({ stick: true });
  startUpload(p);
}

function startUpload(p) {
  const params = new URLSearchParams({ name: p.media.name, clientId: p.clientId });
  if (p.opts.voice) params.set('voice', '1');
  if (p.opts.duration) params.set('duration', String(Math.round(p.opts.duration * 10) / 10));
  if (p.opts.waveform) params.set('waveform', p.opts.waveform.join(','));
  if (p.replyTo) params.set('replyTo', p.replyTo.id);
  p.failed = false;
  upload(`/api/conversations/${p.conversationId}/upload?${params}`, p.blob, (frac) => {
    p.progress = frac;
    const el = document.querySelector(`[data-pid="${p.clientId}"]`);
    if (!el) return;
    const bar = el.querySelector('.progress span');
    if (bar) bar.style.width = Math.round(frac * 100) + '%';
    const label = el.querySelector('.prog-label');
    if (label) label.textContent = (p.kind === 'file' ? 'Uploading ' : '') + Math.round(frac * 100) + '%';
  }).then(({ message }) => {
    resolvePending(p.clientId, message);
    setTimeout(() => URL.revokeObjectURL(p.media.url), 60000);
  }).catch((err) => {
    p.failed = true;
    if (S.activeId === p.conversationId) syncMessages();
    toast(err.message);
  });
}

function retry(clientId) {
  const p = S.pending.find((x) => x.clientId === clientId);
  if (!p) return;
  p.failed = false;
  syncMessages();
  if (p.kind === 'text' && !p.blob) postText(p);
  else startUpload(p);
}

function resolvePending(clientId, message) {
  S.pending = S.pending.filter((p) => p.clientId !== clientId);
  upsertMessage(message);
}

function upsertMessage(m) {
  const conv = S.convs.get(m.conversationId);
  if (m.clientId) S.pending = S.pending.filter((p) => p.clientId !== m.clientId);
  const t = S.threads.get(m.conversationId);
  let isNew = true;
  if (t && t.loaded) {
    const i = t.list.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      t.list[i] = m;
      isNew = false;
    } else {
      t.list.push(m);
      t.list.sort((a, b) => a.id - b.id);
    }
  }
  if (conv && (!conv.lastMessage || m.id >= conv.lastMessage.id)) {
    conv.lastMessage = m;
    conv.updatedAt = m.createdAt;
  }
  if (S.activeId === m.conversationId) syncMessages();
  return isNew;
}

// ----- typing -----

let typingSentAt = 0;
let typingStopTimer;
function typingPing() {
  const cid = S.activeId;
  if (!cid) return;
  const now = Date.now();
  if (now - typingSentAt > 2500) {
    socket.send({ t: 'typing', conversationId: cid, on: true });
    typingSentAt = now;
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(stopTyping, 4000);
}
function stopTyping() {
  clearTimeout(typingStopTimer);
  if (typingSentAt && S.activeId) socket.send({ t: 'typing', conversationId: S.activeId, on: false });
  typingSentAt = 0;
}

// ----- read receipts -----

const markRead = debounce(() => {
  const cid = S.activeId;
  const conv = S.convs.get(cid);
  if (!conv || document.visibilityState !== 'visible') return;
  const box = document.getElementById('messages');
  if (box && box.scrollHeight - box.scrollTop - box.clientHeight > 150) return;
  const t = thread(cid);
  const last = t.list[t.list.length - 1];
  if (!last) return;
  if (last.id > (conv.lastReadId || 0) || conv.unread) {
    conv.lastReadId = Math.max(conv.lastReadId || 0, last.id);
    conv.unread = 0;
    api('POST', `/api/conversations/${cid}/read`, { messageId: last.id }).catch(() => {});
    renderList();
    renderRailBadges();
    updateTitle();
  }
}, 250);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markRead();
});

// ----- voice recording -----

const rec = { active: false };

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice messages are not supported in this browser.');
  if (calls?.inCall()) return toast('Finish your call to record a voice message.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast('Allow microphone access to record voice messages.');
  }
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t));
  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  Object.assign(rec, { active: true, stream, mr, chunks, startedAt: Date.now(), levels: [], cid: S.activeId });
  const ctx = audioCtx();
  if (ctx) {
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    rec.analyser = an;
    rec.src = src;
  }
  mr.start(250);
  document.getElementById('comp-row').hidden = true;
  document.getElementById('rec-row').hidden = false;
  const buf = new Float32Array(1024);
  rec.timer = setInterval(() => {
    const secs = (Date.now() - rec.startedAt) / 1000;
    let level = 0.1;
    if (rec.analyser) {
      rec.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    }
    rec.levels.push(level);
    const timeEl = document.querySelector('.rec-time');
    if (timeEl) timeEl.textContent = fmtDuration(secs);
    const barsEl = document.querySelector('.rec-bars');
    if (barsEl) {
      barsEl.innerHTML = rec.levels.slice(-48).map((l) => `<span style="height:${Math.round(4 + l * 22)}px"></span>`).join('');
    }
    if (secs >= 300) stopRecording(true);
  }, 100);
}

function stopRecording(send) {
  if (!rec.active) return;
  rec.active = false;
  clearInterval(rec.timer);
  const duration = (Date.now() - rec.startedAt) / 1000;
  const { mr, stream, chunks, cid } = rec;
  const levels = rec.levels;
  try { rec.src?.disconnect(); } catch {}
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (!send) return;
    if (duration < 0.6) return toast('Hold on a little longer to record a voice message.');
    const type = (mr.mimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const n = 40;
    const max = Math.max(0.05, ...levels);
    const waveform = Array.from({ length: n }, (_, i) => {
      const slice = levels.slice(Math.floor((i / n) * levels.length), Math.floor(((i + 1) / n) * levels.length));
      const v = slice.length ? Math.max(...slice) : 0;
      return Math.round((v / max) * 100);
    });
    queueUpload(cid, blob, { name: `voice-message.${ext}`, voice: true, duration, waveform });
  };
  mr.stop();
  const cr = document.getElementById('comp-row');
  const rr = document.getElementById('rec-row');
  if (cr) cr.hidden = false;
  if (rr) rr.hidden = true;
}

// ----- drag and drop -----

function setupDrop(el) {
  let depth = 0;
  let zone;
  el.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    if (!zone) {
      zone = document.createElement('div');
      zone.className = 'drop-zone';
      zone.textContent = 'Drop to send';
      el.appendChild(zone);
    }
  });
  el.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth && zone) { zone.remove(); zone = null; }
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    if (zone) { zone.remove(); zone = null; }
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) sendFiles(files);
  });
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------

function renderInfo() {
  const el = document.getElementById('info');
  const shell = shellEl();
  if (!el || !shell) return;
  const conv = S.convs.get(S.activeId);
  const open = S.infoOpen && !!conv;
  el.hidden = !open;
  shell.classList.toggle('info-open', open);
  if (!open) return;
  const o = others(conv);
  el.innerHTML = `
    <div class="info-top"><button class="icon-btn" data-action="toggle-info" aria-label="Close details">${ic('x', 22)}</button></div>
    <div class="info-profile">
      ${conv.isGroup ? groupAvatar(o.length ? o : conv.members, 88) : avatar(o[0] || S.me, 88)}
      <h2 class="h-display">${esc(convTitle(conv))}</h2>
      <span class="muted">${esc(conv.isGroup ? convStatus(conv) : `@${o[0]?.username || ''} · ${convStatus(conv)}`)}</span>
    </div>
    <div class="info-actions">
      <button class="info-action" data-action="call" data-kind="audio"><span>${ic('phone', 20)}</span>Audio</button>
      <button class="info-action" data-action="call" data-kind="video"><span>${ic('video', 22)}</span>Video</button>
      <button class="info-action" data-action="toggle-mute" aria-pressed="${conv.muted}"><span>${ic(conv.muted ? 'bellOff' : 'bell', 20)}</span>${conv.muted ? 'Muted' : 'Mute'}</button>
    </div>
    ${conv.isGroup ? `<section class="info-card"><div style="display:flex;align-items:center;justify-content:space-between">
        <h3>Members</h3><button class="btn ghost" style="height:34px;padding:0 12px;font-size:13px" data-action="rename">Rename</button></div>
      ${conv.members.map((u) => `<div class="member">${avatar(u, 36, { online: u.online && u.id !== S.me.id })}<div><b>${esc(u.displayName)}${u.id === S.me.id ? ' (you)' : ''}</b><span>@${esc(u.username)}</span></div></div>`).join('')}
    </section>` : ''}
    <section class="info-card">
      <h3>Shared</h3>
      <div class="side-chips" style="padding:0" role="group" aria-label="Shared content">
        <button class="chip" data-shared="media" aria-pressed="${S.infoTab === 'media'}">Media</button>
        <button class="chip" data-shared="files" aria-pressed="${S.infoTab === 'files'}">Files</button>
        <button class="chip" data-shared="voice" aria-pressed="${S.infoTab === 'voice'}">Voice</button>
      </div>
      <div id="shared-body"><div class="empty" style="padding:12px"><div class="spinner" role="status" aria-label="Loading"></div></div></div>
    </section>`;
  loadShared();
}

async function loadShared() {
  const cid = S.activeId;
  const tab = S.infoTab;
  if (!cid) return;
  if (!S.shared || S.shared.cid !== cid || S.shared.tab !== tab || S.shared.stale) {
    try {
      const { messages } = await api('GET', `/api/conversations/${cid}/shared?type=${tab}`);
      S.shared = { cid, tab, items: messages };
    } catch {
      S.shared = { cid, tab, items: [] };
    }
  }
  if (S.activeId !== cid || S.infoTab !== tab) return;
  const body = document.getElementById('shared-body');
  if (!body) return;
  const items = S.shared.items;
  if (!items.length) {
    body.innerHTML = `<p class="muted" style="margin:0;font-size:14px">${tab === 'media' ? 'Photos and videos' : tab === 'files' ? 'Files' : 'Voice messages'} you share will show up here.</p>`;
    return;
  }
  if (tab === 'media') {
    body.innerHTML = `<div class="shared-grid">${items.map((m) => m.kind === 'image'
      ? `<button data-action="view" data-id="${m.id}" aria-label="Open photo"><img src="${m.media.url}" alt="" loading="lazy"></button>`
      : `<button data-action="view" data-id="${m.id}" aria-label="Open video"><video src="${m.media.url}#t=0.1" preload="metadata" muted playsinline></video>${m.media.duration ? `<span class="dur">${fmtDuration(m.media.duration)}</span>` : ''}</button>`).join('')}</div>`;
  } else if (tab === 'files') {
    body.innerHTML = `<div class="shared-list">${items.map((m) => `<a class="shared-item" href="${m.media.url}?download=1" download="${esc(m.media.name)}">
      <span class="file-ic">${ic('file', 18)}</span><span class="file-meta"><span class="file-name">${esc(m.media.name)}</span><span class="file-size">${fileSize(m.media.size)} · ${shortTime(m.createdAt)}</span></span>${ic('download', 18)}</a>`).join('')}</div>`;
  } else {
    body.innerHTML = `<div class="shared-list">${items.map((m) => `<button class="shared-item" data-action="jump-to" data-id="${m.id}">
      <span class="file-ic">${ic('mic', 18)}</span><span class="file-meta"><span class="file-name">${esc(m.senderId === S.me.id ? 'You' : userById(m.senderId)?.displayName || '')} · ${fmtDuration(m.media.duration)}</span><span class="file-size">${esc(dividerTime(m.createdAt))}</span></span></button>`).join('')}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Menus, modals, viewer
// ---------------------------------------------------------------------------

let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function openMenu(anchor, html, onClick) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = html;
  document.body.appendChild(menuEl);
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - mw / 2), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const keep = onClick(b.dataset.m, b);
    if (!keep) closeMenu();
  });
  menuEl.querySelector('button, a')?.focus();
}

function messageMenu(anchor, m) {
  const mine = m.senderId === S.me.id;
  const myReact = m.reactions?.find((r) => r.userId === S.me.id)?.key;
  const html = `
    <div class="react-row" role="group" aria-label="React">${REACTIONS.map((r) => `<button data-m="react:${r.key}" aria-label="${r.label}" aria-pressed="${myReact === r.key}">${ic(r.key, 22, r.key === 'heart' && myReact === 'heart' ? 'filled' : '')}</button>`).join('')}</div>
    <hr>
    <button class="menu-item" role="menuitem" data-m="reply">${ic('reply', 20)}Reply</button>
    ${m.kind === 'text' ? `<button class="menu-item" role="menuitem" data-m="copy">${ic('copy', 20)}Copy text</button>` : ''}
    ${m.media ? `<a class="menu-item" role="menuitem" data-m="save" href="${m.media.url}?download=1" download="${esc(m.media.name)}">${ic('download', 20)}Save</a>` : ''}
    ${mine ? `<button class="menu-item danger" role="menuitem" data-m="unsend">${ic('trash', 20)}Unsend</button>` : ''}`;
  openMenu(anchor, html, (action) => {
    if (action.startsWith('react:')) react(m, action.slice(6));
    else if (action === 'reply') setReply(m);
    else if (action === 'copy') navigator.clipboard?.writeText(m.body).then(() => toast('Copied'), () => toast('Could not copy'));
    else if (action === 'unsend') unsend(m);
  });
}

async function react(m, key) {
  try {
    const { message } = await api('POST', `/api/messages/${m.id}/react`, { key });
    upsertMessage(message);
  } catch (err) {
    toast(err.message);
  }
}

async function unsend(m) {
  if (!confirm('Unsend this message for everyone?')) return;
  try {
    const { message } = await api('DELETE', `/api/messages/${m.id}`);
    upsertMessage(message);
    if (player.id === m.id) player.audio.pause();
  } catch (err) {
    toast(err.message);
  }
}

function reactorsMenu(anchor, m) {
  const html = m.reactions.map((r) => {
    const u = userById(r.userId);
    return `<div class="menu-item" style="cursor:default">${avatar(u, 28)}<span style="flex:1">${esc(u?.id === S.me.id ? 'You' : u?.displayName || 'Someone')}</span><span style="color:var(--accent-text)">${ic(r.key, 18, r.key === 'heart' ? 'filled' : '')}</span></div>`;
  }).join('');
  openMenu(anchor, html, () => false);
}

function meMenu(anchor) {
  const canNotify = 'Notification' in window && Notification.permission !== 'granted';
  const html = `
    <div class="menu-head"><b>${esc(S.me.displayName)}</b><span>@${esc(S.me.username)}</span></div><hr>
    <button class="menu-item" role="menuitem" data-m="name">${ic('edit', 20)}Change your name</button>
    ${canNotify ? `<button class="menu-item" role="menuitem" data-m="notify">${ic('bell', 20)}Turn on notifications</button>` : ''}
    <button class="menu-item danger" role="menuitem" data-m="logout">${ic('logout', 20)}Sign out</button>`;
  openMenu(anchor, html, async (action) => {
    if (action === 'logout') signOut();
    if (action === 'notify') {
      const res = await Notification.requestPermission();
      toast(res === 'granted' ? 'Notifications are on.' : 'Notifications are blocked in your browser settings.');
    }
    if (action === 'name') {
      const name = prompt('Your name', S.me.displayName);
      if (name && name.trim() && name.trim() !== S.me.displayName) {
        try {
          const { user } = await api('PATCH', '/api/me', { displayName: name });
          S.me = user;
          renderMeButtons();
          toast('Name updated');
        } catch (err) {
          toast(err.message);
        }
      }
    }
  });
}

function attachMenu(anchor) {
  const html = `
    <button class="menu-item" role="menuitem" data-m="media">${ic('image', 20)}Photos and videos</button>
    <button class="menu-item" role="menuitem" data-m="camera">${ic('camera', 20)}Camera</button>
    <button class="menu-item" role="menuitem" data-m="file">${ic('file', 20)}File</button>
    <button class="menu-item" role="menuitem" data-m="voice">${ic('mic', 20)}Voice message</button>`;
  openMenu(anchor, html, (action) => {
    if (action === 'media') document.getElementById('pick-media').click();
    if (action === 'camera') document.getElementById('pick-camera').click();
    if (action === 'file') document.getElementById('pick-file').click();
    if (action === 'voice') startRecording();
  });
}

['pick-media', 'pick-camera', 'pick-file'].forEach((id) => {
  document.getElementById(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) sendFiles(files);
  });
});

function openModal(html) {
  closeModal();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'modal';
  scrim.innerHTML = html;
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  document.body.appendChild(scrim);
  return scrim;
}
function closeModal() {
  document.getElementById('modal')?.remove();
}

function newChatModal() {
  const picked = new Map();
  let results = [];
  const scrim = openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="nc-title">
      <div class="modal-head"><h2 class="h-display" id="nc-title">New message</h2>
        <button class="icon-btn" data-close aria-label="Close">${ic('x', 22)}</button></div>
      <div class="modal-body">
        <label class="sr" for="nc-search">Search by name or username</label>
        <div class="field-wrap">${ic('search', 18)}<input class="input" id="nc-search" placeholder="Search by name or username" autocomplete="off" autocapitalize="none"></div>
        <div class="picked" id="nc-picked"></div>
        <div id="nc-results"><p class="muted" style="margin:8px 4px;font-size:14px">Type a friend’s username to find them. Pick more than one person to start a group.</p></div>
      </div>
      <div class="modal-foot">
        <div id="nc-group" hidden><label class="sr" for="nc-title-input">Group name</label><input class="input" id="nc-title-input" placeholder="Group name (optional)" maxlength="60"></div>
        <button class="btn primary block" id="nc-go" disabled>Chat</button>
      </div>
    </div>`);
  const input = scrim.querySelector('#nc-search');
  const resEl = scrim.querySelector('#nc-results');
  const go = scrim.querySelector('#nc-go');
  input.focus();
  const draw = () => {
    scrim.querySelector('#nc-picked').innerHTML = [...picked.values()].map((u) =>
      `<button class="chip" data-unpick="${u.id}" aria-label="Remove ${esc(u.displayName)}">${esc(u.displayName)} ${ic('x', 14)}</button>`).join('');
    if (results.length) {
      resEl.innerHTML = results.map((u) => `<button class="pick-row" data-pick="${u.id}" aria-pressed="${picked.has(u.id)}">
        ${avatar(u, 44, { online: u.online })}<span class="row-main"><b>${esc(u.displayName)}</b><span>@${esc(u.username)}</span></span>
        <span class="check">${picked.has(u.id) ? ic('check', 16) : ''}</span></button>`).join('');
    } else if (input.value.trim()) {
      resEl.innerHTML = `<p class="muted" style="margin:8px 4px;font-size:14px">No one found. Check the username and try again.</p>`;
    }
    scrim.querySelector('#nc-group').hidden = picked.size < 2;
    go.disabled = !picked.size;
    go.textContent = picked.size > 1 ? `Create group of ${picked.size + 1}` : 'Chat';
  };
  const search = debounce(async () => {
    const term = input.value.trim();
    if (!term) {
      results = [];
      draw();
      return;
    }
    try {
      const { users } = await api('GET', '/api/users?q=' + encodeURIComponent(term));
      if (input.value.trim() === term) {
        results = users;
        draw();
      }
    } catch (err) {
      toast(err.message);
    }
  }, 200);
  input.addEventListener('input', search);
  scrim.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    const p = e.target.closest('[data-pick]');
    if (p) {
      const u = results.find((x) => x.id === Number(p.dataset.pick));
      if (picked.has(u.id)) {
        picked.delete(u.id);
      } else {
        picked.set(u.id, u);
        input.value = '';
        results = [];
        resEl.innerHTML = '';
        input.focus();
      }
      draw();
      return;
    }
    const up = e.target.closest('[data-unpick]');
    if (up) {
      picked.delete(Number(up.dataset.unpick));
      draw();
      return;
    }
    if (e.target.closest('#nc-go')) {
      go.disabled = true;
      try {
        const title = scrim.querySelector('#nc-title-input').value.trim();
        const { conversation } = await api('POST', '/api/conversations', { userIds: [...picked.keys()], title: picked.size > 1 ? title : undefined });
        S.convs.set(conversation.id, conversation);
        closeModal();
        renderList();
        navigate('/c/' + conversation.id);
      } catch (err) {
        toast(err.message);
        go.disabled = false;
      }
    }
  });
}

function openViewer(id) {
  const t = thread(S.activeId);
  let items = t.list.filter((m) => (m.kind === 'image' || m.kind === 'video') && !m.deleted);
  if (!items.some((m) => m.id === id) && S.shared?.items) items = S.shared.items.slice().reverse();
  let idx = items.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const v = document.createElement('div');
  v.className = 'viewer';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-modal', 'true');
  v.setAttribute('aria-label', 'Media viewer');
  document.body.appendChild(v);
  const draw = () => {
    const m = items[idx];
    const who = m.senderId === S.me.id ? 'You' : userById(m.senderId)?.displayName || '';
    v.innerHTML = `
      <div class="viewer-head">
        <button class="icon-btn" data-v="close" aria-label="Close">${ic('x', 24)}</button>
        <div><b>${esc(who)}</b><span>${esc(dividerTime(m.createdAt))}</span></div>
        <a class="icon-btn" href="${m.media.url}?download=1" download="${esc(m.media.name)}" aria-label="Save" style="color:inherit">${ic('download', 22)}</a>
      </div>
      <div class="viewer-stage">
        ${m.kind === 'image' ? `<img src="${m.media.url}" alt="Photo from ${esc(who)}">` : `<video src="${m.media.url}" controls autoplay playsinline></video>`}
        ${idx > 0 ? `<button class="icon-btn viewer-nav prev" data-v="prev" aria-label="Previous">${ic('back', 24)}</button>` : ''}
        ${idx < items.length - 1 ? `<button class="icon-btn viewer-nav next" data-v="next" aria-label="Next">${ic('right', 24)}</button>` : ''}
      </div>
      <div class="viewer-caption">${m.body ? linkify(m.body) : `${idx + 1} of ${items.length}`}</div>`;
    v.querySelector('[data-v=close]').focus();
  };
  const close = () => {
    v.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft' && idx > 0) { idx--; draw(); }
    if (e.key === 'ArrowRight' && idx < items.length - 1) { idx++; draw(); }
  };
  v.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    if (b.dataset.v === 'close') close();
    if (b.dataset.v === 'prev') { idx--; draw(); }
    if (b.dataset.v === 'next') { idx++; draw(); }
  });
  document.addEventListener('keydown', onKey);
  draw();
}

async function jumpTo(id) {
  const cid = S.activeId;
  const t = thread(cid);
  for (let tries = 0; tries < 6 && !t.list.some((m) => m.id === id) && t.hasMore; tries++) {
    await loadMessages(cid, true);
  }
  const el = document.querySelector(`.msg[data-mid="${id}"]`);
  if (!el) return toast('That message is no longer available.');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.animate([{ background: 'var(--accent-soft)' }, { background: 'transparent' }], { duration: 1400 });
}

// ---------------------------------------------------------------------------
// Global click handling
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    closeMenu();
    navigate(link.getAttribute('href'));
    return;
  }
  if (menuEl && !e.target.closest('.menu') && !e.target.closest('[aria-expanded="true"]')) closeMenu();
  const chip = e.target.closest('[data-filter]');
  if (chip) {
    S.filter = chip.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderList();
    return;
  }
  const sharedTab = e.target.closest('[data-shared]');
  if (sharedTab) {
    S.infoTab = sharedTab.dataset.shared;
    document.querySelectorAll('[data-shared]').forEach((c) => c.setAttribute('aria-pressed', String(c === sharedTab)));
    loadShared();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id != null ? Number(btn.dataset.id) : null;
  switch (action) {
    case 'new-chat': closeMenu(); newChatModal(); break;
    case 'me-menu': meMenu(btn); break;
    case 'toggle-info':
      S.infoOpen = !S.infoOpen;
      renderInfo();
      renderThreadHead();
      break;
    case 'call': {
      const cid = btn.dataset.cid ? Number(btn.dataset.cid) : S.activeId;
      if (cid) calls.start(cid, btn.dataset.kind === 'video' ? 'video' : 'audio');
      break;
    }
    case 'join-call': {
      const conv = S.convs.get(S.activeId);
      if (conv?.activeCall) calls.join(conv.activeCall);
      break;
    }
    case 'send': sendText(); break;
    case 'record': startRecording(); break;
    case 'rec-cancel': stopRecording(false); break;
    case 'rec-send': stopRecording(true); break;
    case 'attach-menu': attachMenu(btn); break;
    case 'pick-media': document.getElementById('pick-media').click(); break;
    case 'cancel-reply': setReply(null); break;
    case 'load-older': loadMessages(S.activeId, true); break;
    case 'retry': retry(btn.dataset.id); break;
    case 'menu': { const m = findMessage(id); if (m) messageMenu(btn, m); break; }
    case 'reactors': { const m = findMessage(id); if (m) reactorsMenu(btn, m); break; }
    case 'view': openViewer(id); break;
    case 'play': playVoice(id); break;
    case 'seek': {
      const r = btn.getBoundingClientRect();
      playVoice(id, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      break;
    }
    case 'jump-to': jumpTo(id); break;
    case 'toggle-mute': {
      const conv = S.convs.get(S.activeId);
      if (!conv) break;
      try {
        await api('PATCH', `/api/conversations/${conv.id}`, { muted: !conv.muted });
        conv.muted = !conv.muted;
        renderInfo();
        renderList();
        renderRailBadges();
        toast(conv.muted ? 'Notifications muted for this chat' : 'Notifications on');
      } catch (err) {
        toast(err.message);
      }
      break;
    }
    case 'rename': {
      const conv = S.convs.get(S.activeId);
      const title = prompt('Group name', conv?.title || '');
      if (title && title.trim()) {
        try { await api('PATCH', `/api/conversations/${conv.id}`, { title }); } catch (err) { toast(err.message); }
      }
      break;
    }
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (menuEl) return closeMenu();
    if (document.getElementById('modal')) return closeModal();
  }
});

// Long-press on touch devices opens the message menu.
let pressTimer;
document.addEventListener('touchstart', (e) => {
  const body = e.target.closest('.msg-body');
  if (!body || e.target.closest('video, .voice, a')) return;
  pressTimer = setTimeout(() => {
    const btn = body.parentElement.querySelector('.more-btn');
    if (btn) {
      navigator.vibrate?.(15);
      btn.click();
    }
  }, 450);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach((ev) => document.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------

let hadConnection = false;
socket.on('open', async () => {
  if (hadConnection) {
    // Catch up on anything we missed while offline.
    await loadConversations();
    if (S.activeId) {
      const t = thread(S.activeId);
      t.loaded = false;
      await loadMessages(S.activeId);
    }
    renderThreadHead();
  }
  hadConnection = true;
});

socket.on('message:new', ({ message: m }) => {
  const conv = S.convs.get(m.conversationId);
  if (!conv) {
    loadConversations();
    return;
  }
  const isNew = upsertMessage(m);
  const mine = m.senderId === S.me.id;
  if (!mine && m.kind !== 'system') {
    const t = S.typing.get(m.conversationId);
    if (t?.has(m.senderId)) {
      clearTimeout(t.get(m.senderId));
      t.delete(m.senderId);
    }
    const viewing = S.activeId === m.conversationId && document.visibilityState === 'visible';
    if (isNew && m.id > (conv.lastReadId || 0)) {
      if (viewing) markRead();
      else conv.unread = (conv.unread || 0) + 1;
    }
    if (isNew && !conv.muted && !viewing) notify(conv, m);
  }
  if (S.shared?.cid === m.conversationId) {
    S.shared.stale = true;
    if (S.infoOpen && S.activeId === m.conversationId && m.media) loadShared();
  }
  renderList();
  renderRailBadges();
  updateTitle();
});

socket.on('message:update', ({ message: m }) => {
  upsertMessage(m);
  renderList();
});

socket.on('read', ({ conversationId, userId, messageId }) => {
  const conv = S.convs.get(conversationId);
  if (!conv) return;
  const member = conv.members.find((u) => u.id === userId);
  if (member) member.lastReadId = Math.max(member.lastReadId || 0, messageId);
  if (userId === S.me.id) {
    conv.lastReadId = Math.max(conv.lastReadId || 0, messageId);
    if (!conv.lastMessage || messageId >= conv.lastMessage.id) conv.unread = 0;
    renderList();
    renderRailBadges();
    updateTitle();
  }
  if (S.activeId === conversationId) syncMessages();
});

socket.on('typing', ({ conversationId, userId, on }) => {
  let m = S.typing.get(conversationId);
  if (!m) {
    m = new Map();
    S.typing.set(conversationId, m);
  }
  clearTimeout(m.get(userId));
  if (on) m.set(userId, setTimeout(() => {
    m.delete(userId);
    renderList();
    if (S.activeId === conversationId) syncMessages();
  }, 6000));
  else m.delete(userId);
  renderList();
  if (S.activeId === conversationId) syncMessages();
});

socket.on('presence', ({ userId, online, lastSeenAt }) => {
  for (const c of S.convs.values()) {
    for (const u of c.members) {
      if (u.id === userId) {
        u.online = online;
        if (lastSeenAt) u.lastSeenAt = lastSeenAt;
      }
    }
  }
  renderList();
  renderThreadHead();
});

socket.on('conversation:new', ({ conversation }) => {
  if (!conversation) return;
  S.convs.set(conversation.id, conversation);
  renderList();
  renderRailBadges();
  updateTitle();
});

socket.on('conversation:update', ({ conversationId, title }) => {
  const conv = S.convs.get(conversationId);
  if (!conv) return;
  conv.title = title;
  renderList();
  renderThreadHead();
  renderInfo();
});

socket.on('user:update', ({ user }) => {
  for (const c of S.convs.values()) {
    for (const u of c.members) if (u.id === user.id) Object.assign(u, user);
  }
  renderList();
  renderThreadHead();
});

function setActiveCall(call, on) {
  const conv = S.convs.get(call.conversationId);
  if (!conv) return;
  conv.activeCall = on ? call : null;
  if (S.activeId === conv.id) renderThreadHead();
}
socket.on('call:incoming', ({ call }) => setActiveCall(call, true));
socket.on('call:state', ({ call }) => setActiveCall(call, true));
socket.on('call:ended', ({ conversationId }) => {
  const conv = S.convs.get(conversationId);
  if (conv) {
    conv.activeCall = null;
    if (S.activeId === conversationId) renderThreadHead();
  }
  if (S.view === 'calls') loadCalls();
  else S.calls = null;
});

function notify(conv, m) {
  beep([988, 1318], 0.07, 0.03, 0.05);
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const sender = userById(m.senderId);
  const title = conv.isGroup ? `${sender?.displayName || 'Someone'} · ${convTitle(conv)}` : sender?.displayName || 'Parley';
  try {
    const n = new Notification(title, { body: messagePreview(m) || 'New message', tag: 'conv-' + conv.id, icon: '/icon-192.png' });
    n.onclick = () => {
      window.focus();
      navigate('/c/' + conv.id);
      n.close();
    };
  } catch {}
}

// Refresh relative times in the list every minute.
setInterval(() => {
  if (S.me && S.view === 'chats') renderList();
  if (S.me) renderThreadHead();
}, 60000);

boot();
