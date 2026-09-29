// Live connections per user, presence, and fan-out helpers.
import { q } from './db.js';

const conns = new Map(); // userId -> Set<WSConnection>

export function addConn(uid, ws) {
  let set = conns.get(uid);
  const first = !set || set.size === 0;
  if (!set) {
    set = new Set();
    conns.set(uid, set);
  }
  set.add(ws);
  return first;
}

export function removeConn(uid, ws) {
  const set = conns.get(uid);
  if (!set) return true;
  set.delete(ws);
  if (set.size === 0) {
    conns.delete(uid);
    return true;
  }
  return false;
}

export function isOnline(uid) {
  const set = conns.get(uid);
  return !!set && set.size > 0;
}

export function allConnections() {
  const out = [];
  for (const set of conns.values()) for (const ws of set) out.push(ws);
  return out;
}

export function sendToUser(uid, msg, exceptWs) {
  const set = conns.get(uid);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws !== exceptWs) ws.send(data);
}

export function sendToUsers(uids, msg, exceptWs) {
  const data = JSON.stringify(msg);
  for (const uid of new Set(uids)) {
    const set = conns.get(uid);
    if (!set) continue;
    for (const ws of set) if (ws !== exceptWs) ws.send(data);
  }
}

export function memberIds(cid) {
  return q.all('SELECT user_id FROM members WHERE conversation_id = ?', cid).map((r) => r.user_id);
}

export function sendToConversation(cid, msg, exceptWs) {
  sendToUsers(memberIds(cid), msg, exceptWs);
}

export function contactsOf(uid) {
  return q.all(
    `SELECT DISTINCT m2.user_id AS id FROM members m1
     JOIN members m2 ON m2.conversation_id = m1.conversation_id
     WHERE m1.user_id = ? AND m2.user_id != ?`,
    uid, uid
  ).map((r) => r.id);
}
