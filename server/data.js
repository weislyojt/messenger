// Queries and JSON shapes shared by the REST API and the realtime layer.
import { db, q } from './db.js';
import { isOnline } from './hub.js';

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    color: u.color,
    lastSeenAt: u.last_seen_at || null,
    online: isOnline(u.id),
  };
}

export function isMember(cid, uid) {
  return !!q.get('SELECT 1 AS ok FROM members WHERE conversation_id = ? AND user_id = ?', cid, uid);
}

function parseMeta(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function previewOf(m) {
  if (!m) return '';
  if (m.deleted_at) return 'Unsent a message';
  switch (m.kind) {
    case 'text': return m.body || '';
    case 'image': return m.body ? 'Photo · ' + m.body : 'Photo';
    case 'video': return m.body ? 'Video · ' + m.body : 'Video';
    case 'audio': return 'Voice message';
    case 'file': return m.media_name || 'File';
    case 'call': {
      const meta = parseMeta(m.meta) || {};
      const label = meta.callKind === 'video' ? 'video call' : 'audio call';
      return meta.missed ? 'Missed ' + label : label[0].toUpperCase() + label.slice(1);
    }
    default: return m.body || '';
  }
}

export function serializeMessages(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const reactRows = db.prepare(`SELECT message_id, user_id, key FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`).all(...ids);
  const reacts = new Map();
  for (const r of reactRows) {
    if (!reacts.has(r.message_id)) reacts.set(r.message_id, []);
    reacts.get(r.message_id).push({ userId: r.user_id, key: r.key });
  }
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    const rph = replyIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT * FROM messages WHERE id IN (${rph})`).all(...replyIds)) replies.set(r.id, r);
  }
  return rows.map((m) => {
    const deleted = !!m.deleted_at;
    const meta = parseMeta(m.meta);
    const reply = m.reply_to_id ? replies.get(m.reply_to_id) : null;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      kind: deleted ? 'deleted' : m.kind,
      body: deleted ? null : m.body,
      media: !deleted && m.media_key ? {
        url: '/media/' + m.media_key,
        name: m.media_name,
        mime: m.media_mime,
        size: m.media_size,
        duration: m.media_duration,
        waveform: meta && Array.isArray(meta.waveform) ? meta.waveform : null,
      } : null,
      call: m.kind === 'call' ? meta : null,
      replyTo: reply ? {
        id: reply.id,
        senderId: reply.sender_id,
        kind: reply.deleted_at ? 'deleted' : reply.kind,
        preview: previewOf(reply),
      } : null,
      reactions: reacts.get(m.id) || [],
      createdAt: m.created_at,
      deleted,
    };
  });
}

export function getMessage(id) {
  const row = q.get('SELECT * FROM messages WHERE id = ?', id);
  return row ? serializeMessages([row])[0] : null;
}

export function conversationFor(cid, uid) {
  const c = q.get('SELECT * FROM conversations WHERE id = ?', cid);
  if (!c) return null;
  const me = q.get('SELECT * FROM members WHERE conversation_id = ? AND user_id = ?', cid, uid);
  if (!me) return null;
  const members = q.all(
    `SELECT u.*, m.last_read_id FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = ? ORDER BY m.joined_at`,
    cid
  );
  const last = q.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', cid);
  const unread = q.get(
    `SELECT COUNT(*) AS n FROM messages
     WHERE conversation_id = ? AND id > ? AND kind != 'system' AND (sender_id IS NULL OR sender_id != ?)`,
    cid, me.last_read_id, uid
  ).n;
  return {
    id: c.id,
    isGroup: !!c.is_group,
    title: c.title,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    muted: !!me.muted,
    lastReadId: me.last_read_id,
    unread,
    members: members.map((u) => ({ ...publicUser(u), lastReadId: u.last_read_id })),
    lastMessage: last ? serializeMessages([last])[0] : null,
  };
}

export function conversationsFor(uid) {
  const rows = q.all(
    `SELECT c.id FROM conversations c JOIN members m ON m.conversation_id = c.id
     WHERE m.user_id = ? ORDER BY c.updated_at DESC`,
    uid
  );
  return rows.map((r) => conversationFor(r.id, uid)).filter(Boolean);
}

export function insertMessage(fields) {
  const now = Date.now();
  const res = q.run(
    `INSERT INTO messages (conversation_id, sender_id, kind, body, media_key, media_name, media_mime,
       media_size, media_duration, meta, reply_to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fields.conversationId,
    fields.senderId ?? null,
    fields.kind,
    fields.body ?? null,
    fields.mediaKey ?? null,
    fields.mediaName ?? null,
    fields.mediaMime ?? null,
    fields.mediaSize ?? null,
    fields.mediaDuration ?? null,
    fields.meta ? JSON.stringify(fields.meta) : null,
    fields.replyToId ?? null,
    now
  );
  const id = Number(res.lastInsertRowid);
  q.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, fields.conversationId);
  if (fields.senderId) {
    q.run(
      'UPDATE members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?',
      id, fields.conversationId, fields.senderId
    );
  }
  return getMessage(id);
}
