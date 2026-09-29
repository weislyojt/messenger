// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close).
// Zero dependencies so the app installs and builds with nothing but Node.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024; // 1 MB per message is plenty for chat + signalling

export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  const ws = new WSConnection(socket);
  if (head && head.length) ws._onData(head);
  return ws;
}

export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.open = true;
    this.alive = true;
    this._done = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(2) * 2 ** 32 + this.buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_FRAME) { this.close(1009); return; }
      const maskLen = masked ? 4 : 0;
      const total = off + maskLen + len;
      if (this.buf.length < total) return;
      let payload = Buffer.from(this.buf.subarray(off + maskLen, total));
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(total);
      this._frame(fin, op, payload);
      if (!this.open) return;
    }
  }

  _frame(fin, op, payload) {
    this.alive = true;
    if (op === 0x8) { this.close(1000); return; }
    if (op === 0x9) { this._send(0xa, payload); return; }
    if (op === 0xa) return;
    if (op === 0x0) {
      this.frags.push(payload);
      if (fin) {
        const all = Buffer.concat(this.frags);
        this.frags = [];
        if (this.fragOp === 0x1) this.emit('message', all.toString('utf8'));
      }
      return;
    }
    if (op === 0x1 || op === 0x2) {
      if (fin) {
        if (op === 0x1) this.emit('message', payload.toString('utf8'));
      } else {
        this.fragOp = op;
        this.frags = [payload];
      }
    }
  }

  _send(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this._send(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this._send(0x8, p);
    this.open = false;
    try { this.socket.end(); } catch {}
    this._closed();
  }

  _closed() {
    if (this._done) return;
    this._done = true;
    this.open = false;
    this.emit('close');
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 1000);
  }
}
