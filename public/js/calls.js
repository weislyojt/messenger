// Voice and video calls over WebRTC. Mesh topology: every participant connects to
// every other participant, which works well for 1:1 and small group calls.
import { ic } from './icons.js';
import { esc, avatar, fmtDuration, beep, toast } from './util.js';

const RING_EVERY_MS = 2200;

export class CallManager {
  constructor(ctx) {
    this.ctx = ctx; // { socket, me(), conv(id), title(conv), userById(id), onChange() }
    this.root = document.getElementById('call-root');
    this.s = null; // active session
    this.incoming = null; // { call }
    this.ringTimer = null;
    const sock = ctx.socket;
    sock.on('call:incoming', (m) => this.onIncoming(m.call));
    sock.on('call:ended', (m) => this.onEnded(m));
    sock.on('call:answered-elsewhere', (m) => {
      if (this.incoming && this.incoming.id === m.callId) this.closeIncoming();
    });
    sock.on('call:peer-joined', (m) => this.onPeerJoined(m));
    sock.on('call:peer-left', (m) => this.onPeerLeft(m));
    sock.on('call:signal', (m) => this.onSignal(m));
    sock.on('call:media', (m) => this.onRemoteMedia(m));
    sock.on('close', () => {
      if (this.s) {
        toast('Connection lost. The call has ended.');
        this.cleanup();
      }
    });
  }

  supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  inCall() {
    return !!this.s;
  }

  // ---------- Outgoing ----------

  async start(conversationId, kind) {
    if (!this.supported()) return toast('Calling is not supported in this browser.');
    if (this.s) {
      this.restore();
      return toast('You are already in a call.');
    }
    const conv = this.ctx.conv(conversationId);
    if (!conv) return;
    const s = this.newSession(conv, kind, 'outgoing');
    this.s = s;
    this.renderSession();
    s.localStream = await this.getMedia(kind);
    if (!s.localStream || this.s !== s) return this.cleanup();
    this.attachLocal();
    const ack = await this.ctx.socket.request({ t: 'call:start', conversationId, kind });
    if (this.s !== s) return;
    if (ack.error) {
      toast(ack.error);
      return this.cleanup();
    }
    s.call = ack.call;
    s.kind = ack.call.kind;
    s.iceServers = ack.iceServers || s.iceServers;
    if (ack.peers && ack.peers.length) {
      // Joined a call that was already running in this chat.
      s.state = 'active';
      s.startedAt = Date.now();
      for (const uid of ack.peers) this.createPeer(uid, true);
    } else {
      this.startRingback();
    }
    this.sendMedia();
    this.renderSession();
    this.ctx.onChange();
  }

  // ---------- Incoming ----------

  onIncoming(call) {
    if (this.s) {
      if (this.s.call && this.s.call.id === call.id) return;
      this.ctx.socket.send({ t: 'call:decline', callId: call.id });
      const conv = this.ctx.conv(call.conversationId);
      toast(`${call.from?.displayName || 'Someone'} tried to call you${conv ? '' : ''}.`);
      return;
    }
    this.incoming = call;
    this.renderIncoming();
    this.startRinging();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${call.from?.displayName || 'Someone'} is calling`, {
          body: call.kind === 'video' ? 'Incoming video call' : 'Incoming audio call',
          tag: 'call-' + call.id,
          requireInteraction: true,
        });
        n.onclick = () => { window.focus(); n.close(); };
        this.incomingNote = n;
      } catch {}
    }
  }

  async accept(audioOnly) {
    const call = this.incoming;
    if (!call) return;
    this.closeIncoming();
    if (!this.supported()) return toast('Calling is not supported in this browser.');
    const conv = this.ctx.conv(call.conversationId);
    if (!conv) return toast('This chat is still loading. Try again.');
    const kind = audioOnly ? 'audio' : call.kind;
    const s = this.newSession(conv, call.kind, 'connecting');
    s.call = call;
    s.sendVideo = kind === 'video';
    this.s = s;
    this.renderSession();
    s.localStream = await this.getMedia(kind);
    if (!s.localStream || this.s !== s) {
      this.ctx.socket.send({ t: 'call:decline', callId: call.id });
      return this.cleanup();
    }
    this.attachLocal();
    const ack = await this.ctx.socket.request({ t: 'call:join', callId: call.id });
    if (this.s !== s) return;
    if (ack.error) {
      toast(ack.error);
      return this.cleanup();
    }
    s.call = ack.call;
    s.iceServers = ack.iceServers || s.iceServers;
    s.state = 'active';
    s.startedAt = Date.now();
    for (const uid of ack.peers) this.createPeer(uid, true);
    this.sendMedia();
    this.renderSession();
    this.ctx.onChange();
  }

  // Join a call already running in a group chat.
  async join(call) {
    if (this.s) return this.restore();
    this.incoming = call;
    return this.accept(false);
  }

  decline() {
    if (!this.incoming) return;
    this.ctx.socket.send({ t: 'call:decline', callId: this.incoming.id });
    this.closeIncoming();
  }

  closeIncoming() {
    this.stopRinging();
    this.incoming = null;
    if (this.incomingNote) {
      try { this.incomingNote.close(); } catch {}
      this.incomingNote = null;
    }
    const el = this.root.querySelector('.call.incoming');
    if (el) el.remove();
  }

  // ---------- Session lifecycle ----------

  newSession(conv, kind, state) {
    return {
      conv,
      kind,
      state, // outgoing | connecting | active | ended
      call: null,
      sendVideo: kind === 'video',
      localStream: null,
      peers: new Map(),
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      muted: false,
      camOff: false,
      sharing: false,
      screenTrack: null,
      facing: 'user',
      canFlip: false,
      startedAt: null,
      tick: null,
      minimized: false,
      endLabel: '',
    };
  }

  async getMedia(kind) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: kind === 'video' ? video : false });
    } catch (err) {
      if (kind === 'video' && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError' || err.name === 'NotReadableError')) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio, video: false });
          if (this.s) this.s.sendVideo = false;
          toast('No camera available, so you joined with audio only.');
          return s;
        } catch {}
      }
      toast(err.name === 'NotAllowedError'
        ? 'Allow microphone' + (kind === 'video' ? ' and camera' : '') + ' access to make calls.'
        : 'Could not start your microphone' + (kind === 'video' ? ' or camera' : '') + '.');
      return null;
    }
  }

  attachLocal() {
    const s = this.s;
    if (!s || !s.localStream) return;
    const v = this.root.querySelector('.pip video');
    if (v) v.srcObject = s.localStream;
    if (s.localStream.getVideoTracks().length && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devs) => {
        if (this.s !== s) return;
        s.canFlip = devs.filter((d) => d.kind === 'videoinput').length > 1;
        this.renderControls();
      }).catch(() => {});
    }
  }

  hangUp() {
    const s = this.s;
    if (!s) return;
    if (s.call) this.ctx.socket.send({ t: 'call:leave', callId: s.call.id });
    this.cleanup();
  }

  cleanup() {
    const s = this.s;
    this.stopRinging();
    if (s) {
      clearInterval(s.tick);
      for (const p of s.peers.values()) {
        try { p.pc.close(); } catch {}
      }
      if (s.localStream) s.localStream.getTracks().forEach((t) => t.stop());
      if (s.screenTrack) s.screenTrack.stop();
    }
    this.s = null;
    this.root.querySelectorAll('.call:not(.incoming), .call-mini').forEach((el) => el.remove());
    this.ctx.onChange();
  }

  onEnded({ callId, reason }) {
    if (this.incoming && this.incoming.id === callId) {
      this.closeIncoming();
      return;
    }
    const s = this.s;
    if (!s || !s.call || s.call.id !== callId) return;
    s.call = null;
    if (reason === 'no-answer' || reason === 'declined') {
      s.state = 'ended';
      s.endLabel = reason === 'declined' ? 'Call declined' : 'No answer';
      this.stopRinging();
      this.renderSession();
      beep([520, 390], 0.18, 0.05, 0.07);
      setTimeout(() => { if (this.s === s) this.cleanup(); }, 1800);
    } else {
      this.cleanup();
    }
  }

  // ---------- Peers ----------

  onPeerJoined({ callId, userId }) {
    const s = this.s;
    if (!s || !s.call || s.call.id !== callId) return;
    this.stopRinging();
    if (s.state !== 'active') {
      s.state = 'active';
      s.startedAt = Date.now();
    }
    // The newcomer sends the offer; we just get a tile ready.
    if (!s.peers.has(userId)) this.createPeer(userId, false);
    this.sendMedia();
    this.renderSession();
  }

  onPeerLeft({ callId, userId }) {
    const s = this.s;
    if (!s || !s.call || s.call.id !== callId) return;
    const p = s.peers.get(userId);
    if (p) {
      try { p.pc.close(); } catch {}
      p.tile?.remove();
      p.audioEl?.remove();
      s.peers.delete(userId);
    }
    this.renderSession();
  }

  createPeer(uid, offerer) {
    const s = this.s;
    const pc = new RTCPeerConnection({ iceServers: s.iceServers });
    const peer = {
      uid,
      pc,
      offerer,
      stream: new MediaStream(),
      pending: [],
      media: { audio: true, video: s.kind === 'video', screen: false },
      tile: null,
      audioEl: null,
      state: 'connecting',
    };
    s.peers.set(uid, peer);
    for (const t of s.localStream.getTracks()) pc.addTrack(t, s.localStream);
    if (s.kind === 'video' && !s.localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (stream) peer.stream = stream;
      else peer.stream.addTrack(e.track);
      this.attachPeer(peer);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(uid, { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed' && peer.offerer) this.restartIce(peer);
      this.updateTile(peer);
    };
    this.renderSession();
    if (offerer) this.makeOffer(peer);
    return peer;
  }

  async makeOffer(peer, iceRestart = false) {
    try {
      const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.pc.setLocalDescription(offer);
      this.signal(peer.uid, { sdp: { type: offer.type, sdp: offer.sdp } });
    } catch (err) {
      console.error('offer failed', err);
    }
  }

  restartIce(peer) {
    if (peer.restarted) return;
    peer.restarted = true;
    try { peer.pc.restartIce?.(); } catch {}
    this.makeOffer(peer, true);
  }

  signal(to, data) {
    const s = this.s;
    if (!s || !s.call) return;
    this.ctx.socket.send({ t: 'call:signal', callId: s.call.id, to, data });
  }

  async onSignal({ callId, from, data }) {
    const s = this.s;
    if (!s || !s.call || s.call.id !== callId) return;
    let peer = s.peers.get(from);
    if (!peer) peer = this.createPeer(from, false);
    const pc = peer.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signal(from, { sdp: { type: answer.type, sdp: answer.sdp } });
        }
        for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (err) {
      console.error('signal handling failed', err);
    }
  }

  onRemoteMedia({ callId, userId, audio, video, screen }) {
    const s = this.s;
    if (!s || !s.call || s.call.id !== callId) return;
    const p = s.peers.get(userId);
    if (!p) return;
    p.media = { audio, video, screen };
    this.updateTile(p);
  }

  sendMedia() {
    const s = this.s;
    if (!s || !s.call) return;
    const hasVideo = !!s.localStream && s.localStream.getVideoTracks().length > 0;
    this.ctx.socket.send({
      t: 'call:media',
      callId: s.call.id,
      audio: !s.muted,
      video: (hasVideo && !s.camOff) || s.sharing,
      screen: s.sharing,
    });
  }

  // ---------- Controls ----------

  toggleMute() {
    const s = this.s;
    if (!s || !s.localStream) return;
    s.muted = !s.muted;
    s.localStream.getAudioTracks().forEach((t) => { t.enabled = !s.muted; });
    this.sendMedia();
    this.renderControls();
    this.renderPip();
  }

  toggleCamera() {
    const s = this.s;
    if (!s || !s.localStream) return;
    s.camOff = !s.camOff;
    s.localStream.getVideoTracks().forEach((t) => { t.enabled = !s.camOff; });
    this.sendMedia();
    this.renderControls();
    this.renderPip();
  }

  async flipCamera() {
    const s = this.s;
    if (!s || !s.localStream || s.sharing) return;
    const facing = s.facing === 'user' ? 'environment' : 'user';
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } } });
      const track = ns.getVideoTracks()[0];
      const old = s.localStream.getVideoTracks()[0];
      track.enabled = !s.camOff;
      for (const p of s.peers.values()) {
        const sender = p.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }
      if (old) {
        s.localStream.removeTrack(old);
        old.stop();
      }
      s.localStream.addTrack(track);
      s.facing = facing;
      this.renderPip();
    } catch {
      toast('Could not switch cameras.');
    }
  }

  async toggleShare() {
    const s = this.s;
    if (!s) return;
    if (s.sharing) return this.stopShare();
    if (!navigator.mediaDevices.getDisplayMedia) return toast('Screen sharing is not supported on this device.');
    const camTrack = s.localStream.getVideoTracks()[0];
    if (!camTrack) return toast('Screen sharing needs a video call.');
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = ds.getVideoTracks()[0];
      s.screenTrack = track;
      s.sharing = true;
      for (const p of s.peers.values()) {
        const sender = p.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
        if (sender) await sender.replaceTrack(track);
      }
      track.onended = () => this.stopShare();
      this.sendMedia();
      this.renderControls();
      this.renderPip();
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Could not share your screen.');
    }
  }

  async stopShare() {
    const s = this.s;
    if (!s || !s.sharing) return;
    const camTrack = s.localStream.getVideoTracks()[0];
    for (const p of s.peers.values()) {
      const sender = p.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender && camTrack) await sender.replaceTrack(camTrack);
    }
    if (s.screenTrack) s.screenTrack.stop();
    s.screenTrack = null;
    s.sharing = false;
    this.sendMedia();
    this.renderControls();
    this.renderPip();
  }

  minimize() {
    if (!this.s) return;
    this.s.minimized = true;
    this.renderSession();
  }

  restore() {
    if (!this.s) return;
    this.s.minimized = false;
    this.renderSession();
  }

  // ---------- Sounds ----------

  startRinging() {
    this.stopRinging();
    const ring = () => {
      beep([784, 988, 784, 988], 0.16, 0.05, 0.09);
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    };
    ring();
    this.ringTimer = setInterval(ring, RING_EVERY_MS);
  }

  startRingback() {
    this.stopRinging();
    const tone = () => beep([440, 440], 0.45, 0.08, 0.05);
    tone();
    this.ringTimer = setInterval(tone, 3000);
  }

  stopRinging() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  // ---------- Rendering ----------

  titleFor(conv) {
    return this.ctx.title(conv);
  }

  heroUser(conv) {
    const me = this.ctx.me();
    const others = conv.members.filter((m) => m.id !== me.id);
    return others[0] || me;
  }

  renderIncoming() {
    const call = this.incoming;
    const conv = this.ctx.conv(call.conversationId);
    const from = call.from || {};
    const title = conv && conv.isGroup ? this.titleFor(conv) : from.displayName || 'Someone';
    const sub = conv && conv.isGroup
      ? `${esc(from.displayName || 'Someone')} is calling · ${call.kind === 'video' ? 'video' : 'audio'}`
      : call.kind === 'video' ? 'Incoming video call' : 'Incoming audio call';
    this.root.querySelector('.call.incoming')?.remove();
    const el = document.createElement('div');
    el.className = 'call incoming';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', `Incoming call from ${from.displayName || 'someone'}`);
    el.innerHTML = `
      <div class="call-hero">
        <div class="ring">${avatar(from, 128)}</div>
        <h2>${esc(title)}</h2>
        <p>${sub}</p>
      </div>
      <div class="call-bar incoming-bar">
        <div class="ctl"><button class="decline" data-c="decline" aria-label="Decline">${ic('phoneOff', 28)}</button>Decline</div>
        ${call.kind === 'video' ? `<div class="ctl"><button data-c="accept-audio" aria-label="Answer with audio only">${ic('phone', 22)}</button>Audio only</div>` : ''}
        <div class="ctl"><button class="accept" data-c="accept" aria-label="Accept">${ic(call.kind === 'video' ? 'video' : 'phone', 28)}</button>Accept</div>
      </div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      if (b.dataset.c === 'decline') this.decline();
      if (b.dataset.c === 'accept') this.accept(false);
      if (b.dataset.c === 'accept-audio') this.accept(true);
    });
    this.root.appendChild(el);
    el.querySelector('.accept').focus();
  }

  ensureOverlay() {
    let el = this.root.querySelector('.call.session');
    if (el) return el;
    const s = this.s;
    el = document.createElement('div');
    el.className = 'call session';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Call with ' + this.titleFor(s.conv));
    el.innerHTML = `
      <div class="call-stage n1"></div>
      <div class="call-hero"></div>
      <div class="call-top">
        <button class="icon-btn" data-c="minimize" aria-label="Minimize call">${ic('down', 22)}</button>
        <div class="call-title"><b>${esc(this.titleFor(s.conv))}</b><span class="call-timer"></span></div>
        <span style="width:44px"></span>
      </div>
      <div class="pip" hidden><video autoplay playsinline muted></video><div class="pip-off" hidden></div><span class="pip-muted" hidden>${ic('micOff', 14)}</span></div>
      <div class="call-bar"></div>
      <div class="call-audio" hidden></div>`;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const c = b.dataset.c;
      if (c === 'minimize') this.minimize();
      if (c === 'mute') this.toggleMute();
      if (c === 'camera') this.toggleCamera();
      if (c === 'flip') this.flipCamera();
      if (c === 'share') this.toggleShare();
      if (c === 'end') this.hangUp();
    });
    this.root.appendChild(el);
    if (s.localStream) el.querySelector('.pip video').srcObject = s.localStream;
    clearInterval(s.tick);
    s.tick = setInterval(() => this.renderTimer(), 1000);
    return el;
  }

  renderSession() {
    const s = this.s;
    if (!s) return;
    const el = this.ensureOverlay();
    el.hidden = s.minimized;
    this.renderMini();
    const stage = el.querySelector('.call-stage');
    const hero = el.querySelector('.call-hero');
    const peers = [...s.peers.values()];
    const video = s.kind === 'video';
    const showHero = s.state !== 'active' || !peers.length || !video;
    if (showHero) {
      const conv = s.conv;
      const heroUser = this.heroUser(conv);
      let status = '';
      if (s.state === 'outgoing') status = 'Calling…';
      else if (s.state === 'connecting') status = 'Connecting…';
      else if (s.state === 'ended') status = s.endLabel;
      else if (!peers.length) status = 'Waiting for others…';
      else status = video ? '' : (peers.length > 1 ? `${peers.length + 1} people on the call` : 'Audio call');
      const people = !video && peers.length > 1
        ? `<div style="display:flex;gap:12px;margin-bottom:10px">${peers.map((p) => avatar(this.ctx.userById(p.uid), 72)).join('')}</div>`
        : `<div class="${s.state === 'outgoing' ? 'ring' : ''}" style="margin-bottom:14px">${avatar(conv.isGroup && peers.length === 1 ? this.ctx.userById(peers[0].uid) : heroUser, 140)}</div>`;
      hero.innerHTML = `${people}<h2>${esc(this.titleFor(conv))}</h2><p class="hero-status">${esc(status)}</p>`;
      hero.hidden = false;
    } else {
      hero.hidden = true;
    }
    stage.hidden = !video || !peers.length || s.state !== 'active';
    stage.className = 'call-stage n' + Math.min(Math.max(peers.length, 1), 6);
    for (const p of peers) {
      if (!p.tile) {
        p.tile = document.createElement('div');
        p.tile.className = 'tile';
        const u = this.ctx.userById(p.uid);
        p.tile.innerHTML = `<video autoplay playsinline></video><div class="tile-av">${avatar(u, 96)}</div>
          <div class="tile-name"><span class="tn-mic" hidden>${ic('micOff', 14)}</span>${esc(u?.displayName || 'Guest')}</div>
          <div class="connecting">Connecting…</div>`;
        if (video) stage.appendChild(p.tile);
        this.attachPeer(p);
      }
      this.updateTile(p);
    }
    this.renderPip();
    this.renderControls();
    this.renderTimer();
  }

  attachPeer(p) {
    const s = this.s;
    if (!s) return;
    if (s.kind === 'video' && p.tile) {
      const v = p.tile.querySelector('video');
      if (v.srcObject !== p.stream) v.srcObject = p.stream;
      v.play?.().catch(() => {});
    } else {
      if (!p.audioEl) {
        p.audioEl = document.createElement('audio');
        p.audioEl.autoplay = true;
        this.root.querySelector('.call-audio')?.appendChild(p.audioEl);
      }
      if (p.audioEl.srcObject !== p.stream) p.audioEl.srcObject = p.stream;
      p.audioEl.play?.().catch(() => {});
    }
    this.updateTile(p);
  }

  updateTile(p) {
    if (!p.tile) return;
    const hasVideoTrack = p.stream.getVideoTracks().some((t) => t.readyState === 'live');
    p.tile.classList.toggle('has-video', hasVideoTrack && p.media.video);
    p.tile.classList.toggle('screen', !!p.media.screen);
    p.tile.querySelector('.tn-mic').hidden = p.media.audio;
    const conn = p.tile.querySelector('.connecting');
    conn.hidden = p.state === 'connected';
    conn.textContent = p.state === 'failed' || p.state === 'disconnected' ? 'Reconnecting…' : 'Connecting…';
  }

  renderPip() {
    const s = this.s;
    const el = this.root.querySelector('.call.session');
    if (!s || !el) return;
    const pip = el.querySelector('.pip');
    const hasVideo = !!s.localStream && s.localStream.getVideoTracks().length > 0;
    pip.hidden = s.kind !== 'video' || !hasVideo;
    if (pip.hidden) return;
    const v = pip.querySelector('video');
    if (s.sharing && s.screenTrack) {
      const ms = new MediaStream([s.screenTrack]);
      if (!v.srcObject || v.srcObject.getVideoTracks()[0] !== s.screenTrack) v.srcObject = ms;
    } else if (v.srcObject !== s.localStream) {
      v.srcObject = s.localStream;
    }
    pip.classList.toggle('screen', s.sharing);
    pip.classList.toggle('rear', s.facing === 'environment');
    const off = pip.querySelector('.pip-off');
    off.hidden = !s.camOff || s.sharing;
    if (!off.hidden) off.innerHTML = `${avatar(this.ctx.me(), 44)}<span>Camera off</span>`;
    v.style.opacity = s.camOff && !s.sharing ? '0' : '1';
    pip.querySelector('.pip-muted').hidden = !s.muted;
  }

  renderControls() {
    const s = this.s;
    const el = this.root.querySelector('.call.session');
    if (!s || !el) return;
    const bar = el.querySelector('.call-bar');
    const hasVideo = !!s.localStream && s.localStream.getVideoTracks().length > 0;
    const parts = [];
    if (s.kind === 'video' && hasVideo && s.canFlip) {
      parts.push(`<div class="ctl"><button data-c="flip" aria-label="Switch camera">${ic('flip', 22)}</button>Flip</div>`);
    }
    if (s.kind === 'video' && hasVideo) {
      parts.push(`<div class="ctl"><button data-c="camera" aria-pressed="${s.camOff}" aria-label="Turn camera off">${ic(s.camOff ? 'videoOff' : 'video', 22)}</button>Camera</div>`);
    }
    parts.push(`<div class="ctl"><button data-c="mute" aria-pressed="${s.muted}" aria-label="Mute microphone">${ic(s.muted ? 'micOff' : 'mic', 22)}</button>${s.muted ? 'Unmute' : 'Mute'}</div>`);
    if (s.kind === 'video' && hasVideo && navigator.mediaDevices.getDisplayMedia && !window.matchMedia('(pointer: coarse)').matches) {
      parts.push(`<div class="ctl"><button data-c="share" aria-pressed="${s.sharing}" aria-label="Share screen">${ic('screen', 22)}</button>${s.sharing ? 'Stop' : 'Share'}</div>`);
    }
    parts.push(`<div class="ctl"><button class="end" data-c="end" aria-label="End call">${ic('phoneOff', 24)}</button>End</div>`);
    bar.innerHTML = parts.join('');
  }

  renderTimer() {
    const s = this.s;
    if (!s) return;
    const label = s.startedAt ? fmtDuration((Date.now() - s.startedAt) / 1000) : s.state === 'outgoing' ? 'Calling…' : s.state === 'ended' ? s.endLabel : 'Connecting…';
    const t = this.root.querySelector('.call-timer');
    if (t) t.textContent = label;
    const m = this.root.querySelector('.call-mini .open span');
    if (m) m.textContent = label;
  }

  renderMini() {
    const s = this.s;
    let mini = this.root.querySelector('.call-mini');
    if (!s || !s.minimized) {
      mini?.remove();
      return;
    }
    if (!mini) {
      mini = document.createElement('div');
      mini.className = 'call-mini';
      mini.innerHTML = `<span class="dotlive" aria-hidden="true"></span>
        <button class="open" aria-label="Return to call">${esc(this.titleFor(s.conv))} · <span></span></button>
        <button class="end" aria-label="End call">${ic('phoneOff', 18)}</button>`;
      mini.querySelector('.open').addEventListener('click', () => this.restore());
      mini.querySelector('.end').addEventListener('click', () => this.hangUp());
      this.root.appendChild(mini);
    }
    this.renderTimer();
  }
}
