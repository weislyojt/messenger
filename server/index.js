import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, UPLOAD_DIR } from './db.js';
import { userIdFromRequest } from './auth.js';
import { isMember } from './data.js';
import { routes, HttpError } from './api.js';
import { acceptUpgrade } from './ws.js';
import { handleConnection } from './realtime.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const INLINE_MEDIA = /^(image\/(jpeg|png|gif|webp|avif|heic)|video\/|audio\/)/;

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const val = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(val && typeof val === 'object' ? val : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

async function handleApi(req, res, url) {
  const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!match) {
    const other = routes.some((r) => r.re.test(url.pathname));
    return sendJson(res, other ? 405 : 404, { error: other ? 'Method not allowed' : 'Not found' });
  }
  const m = match.re.exec(url.pathname);
  const params = {};
  match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  const uid = userIdFromRequest(req);
  if (match.auth && !uid) return sendJson(res, 401, { error: 'Please sign in' });
  if (match.auth && !q.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) return sendJson(res, 401, { error: 'Please sign in' });
  const extraHeaders = {};
  const ctx = {
    req, res, url, params, uid,
    query: url.searchParams,
    ip: clientIp(req),
    body: {},
    setHeader: (k, v) => { extraHeaders[k] = v; },
  };
  if (!match.raw && req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJson(req);
  const out = await match.handler(ctx);
  sendJson(res, 200, out ?? { ok: true }, extraHeaders);
}

function serveMedia(req, res, key) {
  const uid = userIdFromRequest(req);
  if (!uid) return sendJson(res, 401, { error: 'Please sign in' });
  if (!/^[A-Za-z0-9_-]+(\.[a-z0-9]{1,8})?$/.test(key)) return sendJson(res, 404, { error: 'Not found' });
  const row = q.get('SELECT conversation_id, media_mime, media_name, deleted_at FROM messages WHERE media_key = ?', key);
  if (!row || row.deleted_at || !isMember(row.conversation_id, uid)) return sendJson(res, 404, { error: 'Not found' });
  const file = path.join(UPLOAD_DIR, key);
  let stat;
  try { stat = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'Not found' }); }

  const inline = INLINE_MEDIA.test(row.media_mime || '');
  const wantsDownload = new URL(req.url, 'http://x').searchParams.get('download') === '1';
  const headers = {
    'Content-Type': inline ? row.media_mime : 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Disposition': `${inline && !wantsDownload ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.media_name || key)}`,
  };

  const range = req.headers.range;
  if (range) {
    const mm = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (mm && (mm[1] !== '' || mm[2] !== '')) {
      let start;
      let end;
      if (mm[1] === '') {
        start = Math.max(0, stat.size - Number(mm[2]));
        end = stat.size - 1;
      } else {
        start = Number(mm[1]);
        end = mm[2] === '' ? stat.size - 1 : Math.min(Number(mm[2]), stat.size - 1);
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: 'Not found' });
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    // Single-page app: unknown paths without a file extension get the app shell.
    if (path.extname(rel)) return sendJson(res, 404, { error: 'Not found' });
    file = path.join(PUBLIC_DIR, 'index.html');
    stat = fs.statSync(file);
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') {
      q.get('SELECT 1 AS ok');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveMedia(req, res, url.pathname.slice('/media/'.length));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on our side.' });
    else res.destroy();
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const uid = userIdFromRequest(req);
  if (!uid || !q.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const ws = acceptUpgrade(req, socket, head);
  if (ws) handleConnection(ws, uid);
});

server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
server.requestTimeout = 0; // large uploads can take a while

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Parley is running on port ${PORT}`);
});

function shutdown() {
  console.log('Shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
