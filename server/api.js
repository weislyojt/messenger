// REST API. Everything the client needs besides the WebSocket.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { q, tx, UPLOAD_DIR } from './db.js';
import {
  hashPassword, verifyPassword, signToken, sessionCookie, clearCookie, rateLimited,
} from './auth.js';
import {
  publicUser, isMember, conversationFor, conversationsFor, serializeMessages, getMessage, insertMessage,
} from './data.js';
import { sendToUsers, sendToConversation, memberIds } from './hub.js';
import { iceServers, activeCallFor } from './realtime.js';

const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
const REACTIONS = new Set(['heart', 'like', 'laugh', 'wow', 'sad', 'angry']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function requireMember(cid, uid) {
  if (!Number.isInteger(cid) || !isMember(cid, uid)) throw new HttpError(404, 'Chat not found');
}

function cleanText(s, max) {
  return String(s ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function withActiveCall(conv) {
  if (!conv) return conv;
  conv.activeCall = activeCallFor(conv.id);
  return conv;
}

export const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
}

// ---------- Accounts ----------

route('POST', '/api/auth/signup', (ctx) => {
  const ip = ctx.ip;
  if (rateLimited('auth:' + ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const username = cleanText(ctx.body.username, 24).toLowerCase();
  const displayName = cleanText(ctx.body.displayName, 40);
  const password = String(ctx.body.password ?? '');
  if (!/^[a-z0-9_.]{3,24}$/.test(username)) throw bad('Usernames are 3 to 24 letters, numbers, dots or underscores.');
  if (!displayName) throw bad('Enter your name.');
  if (password.length < 8) throw bad('Passwords need at least 8 characters.');
  if (q.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is taken.');
  const color = crypto.randomInt(0, 6);
  const res = q.run(
    'INSERT INTO users (username, display_name, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?)',
    username, displayName, hashPassword(password), color, Date.now()
  );
  const user = q.get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid));
  ctx.setHeader('Set-Cookie', sessionCookie(ctx.req, signToken(user.id)));
  return { user: publicUser(user) };
}, { auth: false });

route('POST', '/api/auth/login', (ctx) => {
  if (rateLimited('auth:' + ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const username = cleanText(ctx.body.username, 24).toLowerCase();
  const user = q.get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !verifyPassword(String(ctx.body.password ?? ''), user.password_hash)) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  ctx.setHeader('Set-Cookie', sessionCookie(ctx.req, signToken(user.id)));
  return { user: publicUser(user) };
}, { auth: false });

route('POST', '/api/auth/logout', (ctx) => {
  ctx.setHeader('Set-Cookie', clearCookie(ctx.req));
  return { ok: true };
}, { auth: false });

route('GET', '/api/me', (ctx) => {
  const user = ctx.uid ? q.get('SELECT * FROM users WHERE id = ?', ctx.uid) : null;
  return { user: user ? publicUser(user) : null };
}, { auth: false });

route('PATCH', '/api/me', (ctx) => {
  const displayName = cleanText(ctx.body.displayName, 40);
  if (!displayName) throw bad('Enter your name.');
  q.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, ctx.uid);
  const user = publicUser(q.get('SELECT * FROM users WHERE id = ?', ctx.uid));
  const contacts = q.all(
    `SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.conversation_id = m1.conversation_id
     WHERE m1.user_id = ?`, ctx.uid
  ).map((r) => r.id);
  sendToUsers(contacts, { t: 'user:update', user });
  return { user };
});

route('GET', '/api/users', (ctx) => {
  const term = cleanText(ctx.query.get('q'), 40).toLowerCase();
  if (!term) return { users: [] };
  const like = '%' + term.replace(/[%_]/g, '') + '%';
  const rows = q.all(
    `SELECT * FROM users WHERE id != ? AND (username LIKE ? OR LOWER(display_name) LIKE ?)
     ORDER BY (username = ?) DESC, display_name LIMIT 20`,
    ctx.uid, like, like, term
  );
  return { users: rows.map(publicUser) };
});

// ---------- Conversations ----------

route('GET', '/api/conversations', (ctx) => ({
  conversations: conversationsFor(ctx.uid).map(withActiveCall),
}));

route('POST', '/api/conversations', (ctx) => {
  const ids = [...new Set((Array.isArray(ctx.body.userIds) ? ctx.body.userIds : []).map(Number))]
    .filter((id) => Number.isInteger(id) && id !== ctx.uid);
  if (!ids.length) throw bad('Pick at least one person.');
  if (ids.length > 49) throw bad('Groups can have up to 50 people.');
  const found = ids.filter((id) => q.get('SELECT 1 AS x FROM users WHERE id = ?', id));
  if (found.length !== ids.length) throw bad('Someone in that list no longer exists.');
  const title = cleanText(ctx.body.title, 60);
  const isGroup = ids.length > 1 || !!title;

  if (!isGroup) {
    const existing = q.get(
      `SELECT c.id FROM conversations c
       WHERE c.is_group = 0
         AND EXISTS (SELECT 1 FROM members WHERE conversation_id = c.id AND user_id = ?)
         AND EXISTS (SELECT 1 FROM members WHERE conversation_id = c.id AND user_id = ?)
         AND (SELECT COUNT(*) FROM members WHERE conversation_id = c.id) = 2`,
      ctx.uid, ids[0]
    );
    if (existing) return { conversation: withActiveCall(conversationFor(existing.id, ctx.uid)) };
  }

  const now = Date.now();
  const cid = tx(() => {
    const res = q.run(
      'INSERT INTO conversations (is_group, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      isGroup ? 1 : 0, title || null, ctx.uid, now, now
    );
    const id = Number(res.lastInsertRowid);
    for (const uid of [ctx.uid, ...ids]) {
      q.run('INSERT INTO members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)', id, uid, now);
    }
    return id;
  });
  if (isGroup) {
    const me = q.get('SELECT display_name FROM users WHERE id = ?', ctx.uid);
    insertMessage({ conversationId: cid, kind: 'system', body: `${me.display_name} created the group` });
  }
  for (const uid of ids) sendToUsers([uid], { t: 'conversation:new', conversation: conversationFor(cid, uid) });
  return { conversation: withActiveCall(conversationFor(cid, ctx.uid)) };
});

route('GET', '/api/conversations/:id', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  return { conversation: withActiveCall(conversationFor(cid, ctx.uid)) };
});

route('PATCH', '/api/conversations/:id', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  if (typeof ctx.body.muted === 'boolean') {
    q.run('UPDATE members SET muted = ? WHERE conversation_id = ? AND user_id = ?', ctx.body.muted ? 1 : 0, cid, ctx.uid);
  }
  if (typeof ctx.body.title === 'string') {
    const conv = q.get('SELECT is_group FROM conversations WHERE id = ?', cid);
    const title = cleanText(ctx.body.title, 60);
    if (conv.is_group && title) {
      q.run('UPDATE conversations SET title = ? WHERE id = ?', title, cid);
      const me = q.get('SELECT display_name FROM users WHERE id = ?', ctx.uid);
      const msg = insertMessage({ conversationId: cid, kind: 'system', body: `${me.display_name} named the group ${title}` });
      sendToConversation(cid, { t: 'message:new', message: msg });
      sendToConversation(cid, { t: 'conversation:update', conversationId: cid, title });
    }
  }
  return { conversation: withActiveCall(conversationFor(cid, ctx.uid)) };
});

route('GET', '/api/conversations/:id/messages', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  const before = Number(ctx.query.get('before')) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 50, 1), 100);
  const rows = q.all(
    'SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
    cid, before, limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: serializeMessages(page), hasMore };
});

route('POST', '/api/conversations/:id/messages', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  const body = cleanText(ctx.body.body, 5000);
  if (!body) throw bad('Message is empty.');
  const replyToId = validReply(cid, ctx.body.replyToId);
  const message = insertMessage({ conversationId: cid, senderId: ctx.uid, kind: 'text', body, replyToId });
  message.clientId = typeof ctx.body.clientId === 'string' ? ctx.body.clientId.slice(0, 64) : undefined;
  sendToConversation(cid, { t: 'message:new', message });
  return { message };
});

function validReply(cid, replyToId) {
  const id = Number(replyToId);
  if (!id) return null;
  const row = q.get('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', id, cid);
  return row ? row.id : null;
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
  'application/pdf': '.pdf',
};

route('POST', '/api/conversations/:id/upload', async (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  const declared = Number(ctx.req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1048576} MB.`);
  const mime = cleanText(String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0], 100).toLowerCase() || 'application/octet-stream';
  const name = cleanText(ctx.query.get('name') || 'file', 120).replace(/[\\/]/g, '_') || 'file';
  const isVoice = ctx.query.get('voice') === '1';
  let kind = 'file';
  if (isVoice || mime.startsWith('audio/')) kind = 'audio';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('image/') && mime !== 'image/svg+xml') kind = 'image';

  const ext = EXT_BY_MIME[mime] || (path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8));
  const key = crypto.randomBytes(18).toString('base64url') + ext;
  const file = path.join(UPLOAD_DIR, key);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) cb(new HttpError(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1048576} MB.`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(ctx.req, limiter, fs.createWriteStream(file, { flags: 'wx' }));
  } catch (err) {
    fs.rm(file, { force: true }, () => {});
    throw err instanceof HttpError ? err : new HttpError(400, 'Upload failed. Please try again.');
  }
  if (size === 0) {
    fs.rm(file, { force: true }, () => {});
    throw bad('That file is empty.');
  }

  let meta = null;
  const wave = ctx.query.get('waveform');
  if (wave) {
    const bars = wave.split(',').slice(0, 64).map((n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0))));
    meta = { waveform: bars };
  }
  const duration = Number(ctx.query.get('duration'));
  const message = insertMessage({
    conversationId: cid,
    senderId: ctx.uid,
    kind,
    body: cleanText(ctx.query.get('caption'), 2000) || null,
    mediaKey: key,
    mediaName: name,
    mediaMime: mime,
    mediaSize: size,
    mediaDuration: Number.isFinite(duration) && duration > 0 ? Math.min(duration, 36000) : null,
    meta,
    replyToId: validReply(cid, ctx.query.get('replyTo')),
  });
  message.clientId = cleanText(ctx.query.get('clientId'), 64) || undefined;
  sendToConversation(cid, { t: 'message:new', message });
  return { message };
}, { raw: true });

route('POST', '/api/conversations/:id/read', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  const messageId = Number(ctx.body.messageId) || 0;
  const latest = q.get('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?', cid).id || 0;
  const target = Math.min(messageId, latest);
  const res = q.run(
    'UPDATE members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ? AND last_read_id < ?',
    target, cid, ctx.uid, target
  );
  if (res.changes) sendToConversation(cid, { t: 'read', conversationId: cid, userId: ctx.uid, messageId: target });
  return { ok: true };
});

route('GET', '/api/conversations/:id/shared', (ctx) => {
  const cid = Number(ctx.params.id);
  requireMember(cid, ctx.uid);
  const type = ctx.query.get('type') || 'media';
  const kinds = type === 'files' ? ['file'] : type === 'voice' ? ['audio'] : ['image', 'video'];
  const rows = q.all(
    `SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL
       AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 120`,
    cid, ...kinds
  );
  return { messages: serializeMessages(rows) };
});

// ---------- Messages ----------

route('POST', '/api/messages/:id/react', (ctx) => {
  const id = Number(ctx.params.id);
  const row = q.get('SELECT * FROM messages WHERE id = ?', id);
  if (!row || !isMember(row.conversation_id, ctx.uid) || row.deleted_at) throw new HttpError(404, 'Message not found');
  const key = ctx.body.key == null ? null : String(ctx.body.key);
  const current = q.get('SELECT key FROM reactions WHERE message_id = ? AND user_id = ?', id, ctx.uid);
  if (!key || (current && current.key === key)) {
    q.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ?', id, ctx.uid);
  } else {
    if (!REACTIONS.has(key)) throw bad('Unknown reaction');
    q.run(
      `INSERT INTO reactions (message_id, user_id, key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at`,
      id, ctx.uid, key, Date.now()
    );
  }
  const message = getMessage(id);
  sendToConversation(row.conversation_id, { t: 'message:update', message });
  return { message };
});

route('DELETE', '/api/messages/:id', (ctx) => {
  const id = Number(ctx.params.id);
  const row = q.get('SELECT * FROM messages WHERE id = ?', id);
  if (!row || row.sender_id !== ctx.uid || !isMember(row.conversation_id, ctx.uid)) throw new HttpError(404, 'Message not found');
  if (row.kind === 'call' || row.kind === 'system') throw bad('This message cannot be unsent.');
  q.run('UPDATE messages SET deleted_at = ?, body = NULL WHERE id = ?', Date.now(), id);
  q.run('DELETE FROM reactions WHERE message_id = ?', id);
  if (row.media_key) fs.rm(path.join(UPLOAD_DIR, row.media_key), { force: true }, () => {});
  const message = getMessage(id);
  sendToConversation(row.conversation_id, { t: 'message:update', message });
  return { message };
});

// ---------- Calls ----------

route('GET', '/api/calls', (ctx) => {
  const rows = q.all(
    `SELECT c.*, (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = ?) AS joined
     FROM calls c JOIN members m ON m.conversation_id = c.conversation_id AND m.user_id = ?
     WHERE c.ended_at IS NOT NULL ORDER BY c.id DESC LIMIT 100`,
    ctx.uid, ctx.uid
  );
  return {
    calls: rows.map((c) => ({
      id: c.id,
      conversationId: c.conversation_id,
      kind: c.kind,
      startedBy: c.started_by,
      startedAt: c.started_at,
      duration: c.answered_at ? Math.round((c.ended_at - c.answered_at) / 1000) : 0,
      direction: c.started_by === ctx.uid ? 'outgoing' : c.joined ? 'incoming' : 'missed',
      answered: !!c.answered_at,
    })),
  };
});

route('GET', '/api/ice', () => ({ iceServers: iceServers() }));

export { memberIds };
