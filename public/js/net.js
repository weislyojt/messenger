// REST helper and a reconnecting WebSocket client.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'You appear to be offline.');
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    throw new ApiError(res.status, data.error || 'Something went wrong.');
  }
  return data;
}

// Upload a Blob/File as the raw request body so we can report progress.
export function upload(path, blob, onProgress) {
  let xhr;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error || 'Upload failed.'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed. Check your connection.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.send(blob);
  });
  promise.abort = () => xhr && xhr.abort();
  return promise;
}

export class Socket {
  constructor() {
    this.handlers = new Map();
    this.pending = new Map();
    this.rid = 0;
    this.backoff = 1000;
    this.stopped = false;
    this.ws = null;
    this.connected = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(msg); } catch (err) { console.error(err); }
    }
  }

  connect() {
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.emit('open');
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'ack') {
        const p = this.pending.get(msg.rid);
        if (p) {
          this.pending.delete(msg.rid);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
        return;
      }
      this.emit(msg.t, msg);
    };
    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.ws !== ws) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ error: 'Connection lost' });
      }
      this.pending.clear();
      if (wasConnected) this.emit('close');
      if (!this.stopped) {
        setTimeout(() => { if (!this.stopped) this.connect(); }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10000);
      }
    };
  }

  disconnect() {
    this.stopped = true;
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  request(msg, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const rid = 'r' + (++this.rid);
      if (!this.send({ ...msg, rid })) {
        resolve({ error: 'Not connected. Trying to reconnect…' });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({ error: 'No response from server' });
      }, timeoutMs);
      this.pending.set(rid, { resolve, timer });
    });
  }
}
