// WebSocket session handling: presence, typing, and call signalling.
import { q } from './db.js';
import {
  addConn, removeConn, allConnections, sendToUser, sendToUsers, sendToConversation, memberIds, contactsOf,
} from './hub.js';
import { isMember, insertMessage, publicUser } from './data.js';

const RING_TIMEOUT_MS = 40 * 1000;

// Active calls live in memory; the calls table keeps the history.
const calls = new Map(); // callId -> call
const userCall = new Map(); // userId -> callId the user is currently in

export function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

function callPublic(call) {
  const starter = q.get('SELECT * FROM users WHERE id = ?', call.startedBy);
  return {
    id: call.id,
    conversationId: call.conversationId,
    kind: call.kind,
    startedBy: call.startedBy,
    from: starter ? publicUser(starter) : null,
    participants: [...call.participants.keys()],
    answered: call.answered,
    startedAt: call.startedAt,
  };
}

export function activeCallFor(conversationId) {
  for (const c of calls.values()) if (c.conversationId === conversationId) return callPublic(c);
  return null;
}

function endCall(call, reason) {
  if (!calls.has(call.id)) return;
  calls.delete(call.id);
  clearTimeout(call.ringTimer);
  const now = Date.now();
  q.run('UPDATE calls SET ended_at = ? WHERE id = ?', now, call.id);
  for (const uid of call.participants.keys()) if (userCall.get(uid) === call.id) userCall.delete(uid);
  const everyone = memberIds(call.conversationId);
  sendToUsers(everyone, { t: 'call:ended', callId: call.id, conversationId: call.conversationId, reason });
  const duration = call.answeredAt ? Math.round((now - call.answeredAt) / 1000) : 0;
  const msg = insertMessage({
    conversationId: call.conversationId,
    senderId: call.startedBy,
    kind: 'call',
    meta: { callId: call.id, callKind: call.kind, duration, missed: !call.answered },
  });
  sendToConversation(call.conversationId, { t: 'message:new', message: msg });
}

function leaveCall(uid, callId, ws) {
  const call = calls.get(callId);
  if (!call) return;
  const entry = call.participants.get(uid);
  if (!entry || (ws && entry !== ws)) return;
  call.participants.delete(uid);
  if (userCall.get(uid) === callId) userCall.delete(uid);
  for (const [pid, pws] of call.participants) pws.send({ t: 'call:peer-left', callId, userId: uid });
  if (!call.answered) {
    // The caller hung up before anyone answered.
    if (call.participants.size === 0) endCall(call, 'cancelled');
    return;
  }
  if (call.participants.size < 2) endCall(call, 'ended');
}

function startCall(uid, ws, { conversationId, kind }) {
  conversationId = Number(conversationId);
  if (!isMember(conversationId, uid)) return { error: 'Not a member of this chat' };
  if (kind !== 'audio' && kind !== 'video') kind = 'audio';
  const existing = [...calls.values()].find((c) => c.conversationId === conversationId);
  if (existing) return joinCall(uid, ws, { callId: existing.id });
  if (userCall.has(uid)) leaveCall(uid, userCall.get(uid));
  const now = Date.now();
  const res = q.run('INSERT INTO calls (conversation_id, started_by, kind, started_at) VALUES (?, ?, ?, ?)', conversationId, uid, kind, now);
  const call = {
    id: Number(res.lastInsertRowid),
    conversationId,
    kind,
    startedBy: uid,
    startedAt: now,
    answered: false,
    answeredAt: null,
    participants: new Map([[uid, ws]]),
    declined: new Set(),
    ringTimer: null,
  };
  calls.set(call.id, call);
  userCall.set(uid, call.id);
  q.run('INSERT OR IGNORE INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)', call.id, uid, now);
  call.ringTimer = setTimeout(() => {
    if (!call.answered) endCall(call, 'no-answer');
  }, RING_TIMEOUT_MS);
  const others = memberIds(conversationId).filter((id) => id !== uid);
  sendToUsers(others, { t: 'call:incoming', call: callPublic(call) });
  sendToUser(uid, { t: 'call:state', call: callPublic(call) }, ws);
  return { call: callPublic(call), peers: [], iceServers: iceServers() };
}

function joinCall(uid, ws, { callId }) {
  const call = calls.get(Number(callId));
  if (!call) return { error: 'This call has ended' };
  if (!isMember(call.conversationId, uid)) return { error: 'Not a member of this chat' };
  const current = userCall.get(uid);
  if (current && current !== call.id) leaveCall(uid, current);
  const now = Date.now();
  const peers = [...call.participants.keys()].filter((id) => id !== uid);
  call.participants.set(uid, ws);
  userCall.set(uid, call.id);
  q.run('INSERT OR IGNORE INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)', call.id, uid, now);
  if (!call.answered && uid !== call.startedBy) {
    call.answered = true;
    call.answeredAt = now;
    clearTimeout(call.ringTimer);
    q.run('UPDATE calls SET answered_at = ? WHERE id = ?', now, call.id);
  }
  for (const pid of peers) call.participants.get(pid)?.send({ t: 'call:peer-joined', callId: call.id, userId: uid });
  // Stop ringing on this user's other tabs and devices.
  sendToUser(uid, { t: 'call:answered-elsewhere', callId: call.id }, ws);
  return { call: callPublic(call), peers, iceServers: iceServers() };
}

function declineCall(uid, { callId }) {
  const call = calls.get(Number(callId));
  if (!call) return { ok: true };
  call.declined.add(uid);
  sendToUser(uid, { t: 'call:answered-elsewhere', callId: call.id });
  const invitees = memberIds(call.conversationId).filter((id) => id !== call.startedBy);
  if (!call.answered && invitees.every((id) => call.declined.has(id))) endCall(call, 'declined');
  return { ok: true };
}

function relaySignal(uid, { callId, to, data }) {
  const call = calls.get(Number(callId));
  if (!call || !call.participants.has(uid)) return;
  call.participants.get(Number(to))?.send({ t: 'call:signal', callId: call.id, from: uid, data });
}

function relayMedia(uid, { callId, audio, video, screen }) {
  const call = calls.get(Number(callId));
  if (!call || !call.participants.has(uid)) return;
  for (const [pid, pws] of call.participants) {
    if (pid !== uid) pws.send({ t: 'call:media', callId: call.id, userId: uid, audio: !!audio, video: !!video, screen: !!screen });
  }
}

export function handleConnection(ws, uid) {
  const first = addConn(uid, ws);
  if (first) sendToUsers(contactsOf(uid), { t: 'presence', userId: uid, online: true });
  ws.send({ t: 'hello', userId: uid, iceServers: iceServers() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    let reply;
    try {
      switch (msg.t) {
        case 'ping':
          reply = { ok: true };
          break;
        case 'typing': {
          const cid = Number(msg.conversationId);
          if (isMember(cid, uid)) {
            sendToUsers(memberIds(cid).filter((id) => id !== uid), { t: 'typing', conversationId: cid, userId: uid, on: !!msg.on });
          }
          break;
        }
        case 'call:start': reply = startCall(uid, ws, msg); break;
        case 'call:join': reply = joinCall(uid, ws, msg); break;
        case 'call:decline': reply = declineCall(uid, msg); break;
        case 'call:leave': leaveCall(uid, Number(msg.callId), ws); reply = { ok: true }; break;
        case 'call:signal': relaySignal(uid, msg); break;
        case 'call:media': relayMedia(uid, msg); break;
        default: break;
      }
    } catch (err) {
      console.error('ws handler error', err);
      reply = { error: 'Something went wrong' };
    }
    if (msg.rid && reply !== undefined) ws.send({ t: 'ack', rid: msg.rid, ...reply });
  });

  ws.on('close', () => {
    const cid = userCall.get(uid);
    if (cid) leaveCall(uid, cid, ws);
    const last = removeConn(uid, ws);
    if (last) {
      const now = Date.now();
      q.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, uid);
      sendToUsers(contactsOf(uid), { t: 'presence', userId: uid, online: false, lastSeenAt: now });
    }
  });
}

// Keep connections alive through proxies and drop dead ones.
setInterval(() => {
  for (const ws of allConnections()) {
    if (!ws.alive) { ws.close(1001); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25 * 1000).unref();
