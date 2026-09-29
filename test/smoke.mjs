// Backend smoke test: two users, chat, media, reactions, reads, and call signalling.
const BASE = process.env.BASE || 'http://localhost:3100';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } else console.log('ok -', m); };

async function client(username, displayName) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), cookie, ...headers },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  const r = await call('POST', '/api/auth/signup', { username, displayName, password: 'password123' });
  assert(r.status === 200, `signup ${username} (${r.status} ${JSON.stringify(r.data).slice(0, 80)})`);
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const events = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    events.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let rid = 0;
  const request = (msg) => new Promise((resolve) => {
    const id = 'r' + (++rid);
    waiters.push({ pred: (m) => m.t === 'ack' && m.rid === id, resolve });
    ws.send(JSON.stringify({ ...msg, rid: id }));
  });
  const next = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const found = events.find(pred);
    if (found) { events.splice(events.indexOf(found), 1); return resolve(found); }
    const w = { pred, resolve: (m) => { clearTimeout(t); events.splice(events.indexOf(m), 1); resolve(m); } };
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting')); }, ms);
    waiters.push(w);
  });
  return { call, ws, request, next, user: r.data.user };
}

const a = await client('mika', 'Mika Reyes');
const b = await client('jun', 'Jun Park');

let r = await a.call('GET', '/api/users?q=ju');
assert(r.data.users.length === 1 && r.data.users[0].online === true, 'search finds online user');
r = await a.call('POST', '/api/conversations', { userIds: [b.user.id] });
const cid = r.data.conversation.id;
assert(cid, 'create DM');
await b.next((m) => m.t === 'conversation:new');
assert(true, 'invitee notified of new chat');
r = await a.call('POST', '/api/conversations', { userIds: [b.user.id] });
assert(r.data.conversation.id === cid, 'DM is reused');

a.ws.send(JSON.stringify({ t: 'typing', conversationId: cid, on: true }));
await b.next((m) => m.t === 'typing' && m.on);
assert(true, 'typing relayed');

r = await a.call('POST', `/api/conversations/${cid}/messages`, { body: 'Hello Jun', clientId: 'c1' });
assert(r.data.message.clientId === 'c1', 'send message');
const m1 = await b.next((m) => m.t === 'message:new');
assert(m1.message.body === 'Hello Jun', 'message delivered in realtime');
r = await b.call('GET', '/api/conversations');
assert(r.data.conversations[0].unread === 1, 'unread count 1');
await b.call('POST', `/api/conversations/${cid}/read`, { messageId: m1.message.id });
await a.next((m) => m.t === 'read' && m.userId === b.user.id);
assert(true, 'read receipt delivered');

const bytes = new Uint8Array(5000).map((_, i) => i % 256);
r = await b.call('POST', `/api/conversations/${cid}/upload?name=clip.webm&voice=1&duration=3.2&waveform=10,50,90&replyTo=${m1.message.id}`, bytes, { 'Content-Type': 'audio/webm' });
assert(r.status === 200 && r.data.message.kind === 'audio' && r.data.message.replyTo.id === m1.message.id, 'voice upload with reply');
const media = r.data.message.media;
assert(media.waveform.length === 3 && media.duration === 3.2, 'waveform + duration stored');
r = await a.call('GET', media.url, null, { range: 'bytes=100-199' });
assert(r.status === 206 && r.data.length === 100 && r.data[0] === 100, 'range request');
const outsider = await client('theo', 'Theo Ramos');
r = await outsider.call('GET', media.url);
assert(r.status === 404, 'non-member cannot read media');
r = await b.call('POST', `/api/conversations/${cid}/upload?name=page.html`, new TextEncoder().encode('<script>alert(1)</script>'), { 'Content-Type': 'text/html' });
assert(r.data.message.kind === 'file', 'html upload is a file');
r = await a.call('GET', r.data.message.media.url);
assert(r.headers.get('content-type') === 'application/octet-stream' && r.headers.get('content-disposition').startsWith('attachment'), 'files are served as downloads');

r = await a.call('POST', `/api/messages/${m1.message.id}/react`, { key: 'heart' });
assert(r.data.message.reactions[0].key === 'heart', 'react');
await b.next((m) => m.t === 'message:update');
r = await a.call('POST', `/api/messages/${m1.message.id}/react`, { key: 'heart' });
assert(r.data.message.reactions.length === 0, 'react toggles off');
r = await a.call('DELETE', `/api/messages/${m1.message.id}`);
assert(r.data.message.deleted, 'unsend');

// Group chat
r = await a.call('POST', '/api/conversations', { userIds: [b.user.id, outsider.user.id], title: 'Weekend Squad' });
const gid = r.data.conversation.id;
assert(r.data.conversation.isGroup && r.data.conversation.members.length === 3, 'group created');

// Calls: a calls b, b declines -> ended
let ack = await a.request({ t: 'call:start', conversationId: cid, kind: 'video' });
assert(ack.call && ack.iceServers.length, 'call started');
let inc = await b.next((m) => m.t === 'call:incoming');
assert(inc.call.kind === 'video' && inc.call.from.id === a.user.id, 'callee rings');
await b.request({ t: 'call:decline', callId: inc.call.id });
await a.next((m) => m.t === 'call:ended' && m.reason === 'declined');
assert(true, 'decline ends call for caller');
const missed = await a.next((m) => m.t === 'message:new' && m.message.kind === 'call');
assert(missed.message.call.missed === true, 'missed call message');

// Call answered + signalling relay + hang up
ack = await a.request({ t: 'call:start', conversationId: cid, kind: 'audio' });
inc = await b.next((m) => m.t === 'call:incoming');
const join = await b.request({ t: 'call:join', callId: inc.call.id });
assert(join.peers.length === 1 && join.peers[0] === a.user.id, 'join returns peers');
await a.next((m) => m.t === 'call:peer-joined');
b.ws.send(JSON.stringify({ t: 'call:signal', callId: inc.call.id, to: a.user.id, data: { sdp: { type: 'offer', sdp: 'x' } } }));
const sig = await a.next((m) => m.t === 'call:signal');
assert(sig.from === b.user.id && sig.data.sdp.type === 'offer', 'signal relayed');
b.ws.send(JSON.stringify({ t: 'call:media', callId: inc.call.id, audio: false, video: false }));
await a.next((m) => m.t === 'call:media' && m.audio === false);
assert(true, 'media state relayed');
await new Promise((r2) => setTimeout(r2, 1100));
await a.request({ t: 'call:leave', callId: inc.call.id });
await b.next((m) => m.t === 'call:ended');
const done = await a.next((m) => m.t === 'message:new' && m.message.kind === 'call');
assert(done.message.call.missed === false && done.message.call.duration >= 1, 'answered call logged with duration');
r = await b.call('GET', '/api/calls');
assert(r.data.calls.length === 2 && r.data.calls[0].direction === 'incoming' && r.data.calls[1].direction === 'missed', 'call history directions');

// Presence
outsider.ws.close();
const pres = await a.next((m) => m.t === 'presence' && m.userId === outsider.user.id && !m.online);
assert(pres.lastSeenAt, 'offline presence');

r = await a.call('POST', '/api/auth/login', { username: 'mika', password: 'nope-nope' });
assert(r.status === 401, 'wrong password rejected');
console.log('\nAll backend checks passed');
process.exit(0);
