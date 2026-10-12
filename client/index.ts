/**
 * Browser client for lan-signal: list the games on your network, host one,
 * or join one, and get back a connected RTCPeerConnection. No dependencies.
 *
 *   const sig = await SignalClient.connect('wss://signal.example.com', { app: 'my-game' });
 *   // Host:
 *   const room = await sig.host({ name: 'Ann\'s game', passphrase: 'spades', meta: { map: 'kauai' } });
 *   room.onPeer = (pc, peerId) => { ... };          // each joiner, once connected
 *   // Join:
 *   const rooms = await sig.list();
 *   const pc = await sig.join(rooms[0].id, { passphrase: 'spades', setup: (pc) => makeChannels(pc) });
 *
 * LAN only (default): only host (LAN or mDNS) ICE candidates are exchanged,
 * no STUN or TURN servers are used, and a connection whose chosen route is
 * not between two local addresses is closed. With a passphrase, every
 * signaling payload is AES-GCM encrypted with a key derived from it, so the
 * relay can't read them and a joiner without it can't connect.
 */

export interface RoomInfo {
  id: string;
  name: string;
  locked: boolean;
  meta: unknown;
}

export interface PeerOptions {
  /** Called on each new RTCPeerConnection before negotiation: create negotiated data channels here. */
  setup?: (pc: RTCPeerConnection) => void;
}

export interface HostOptions extends PeerOptions {
  name: string;
  passphrase?: string;
  meta?: unknown;
}

export interface JoinOptions extends PeerOptions {
  passphrase?: string;
  /** Give up after this many milliseconds (default 20 s). */
  timeoutMs?: number;
}

export interface ClientOptions {
  /** App id: rooms are only visible to the same app. Lower-case letters, digits, dashes. */
  app: string;
  /** Allow connections over non-LAN routes (default false). */
  allowInternet?: boolean;
  /** ICE servers (default none when LAN only). */
  iceServers?: RTCIceServer[];
}

export class SignalError extends Error {}

type ServerMsg =
  | { t: 'hello'; id: string }
  | { t: 'hosted'; room: RoomInfo }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'joined'; room: RoomInfo }
  | { t: 'peer'; peer: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'pong' }
  | { t: 'error'; message: string };

/** What peers say to each other through the relay (encrypted when locked). */
type PeerMsg =
  | { k: 'hello' }
  | { k: 'denied' }
  | { k: 'offer'; sdp: string }
  | { k: 'answer'; sdp: string }
  | { k: 'ice'; c: RTCIceCandidateInit };

const KEEPALIVE_MS = 4 * 60 * 1000;

export class SignalClient {
  /** This connection's id (a room's id when hosting). */
  id = '';
  private readonly waiters: { t: ServerMsg['t']; resolve: (m: ServerMsg) => void; reject: (e: Error) => void }[] = [];
  private readonly peerHandlers = new Map<string, (data: unknown) => void>();
  private onPeerJoin: ((peer: string) => void) | null = null;
  private keepalive = 0;
  /** The connection to the relay dropped. */
  onClose: () => void = () => {};

  private readonly ws: WebSocket;
  readonly opts: ClientOptions;

  private constructor(ws: WebSocket, opts: ClientOptions) {
    this.ws = ws;
    this.opts = opts;
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMsg);
    ws.onclose = () => {
      clearInterval(this.keepalive);
      for (const w of this.waiters.splice(0)) w.reject(new SignalError('The signaling server connection closed.'));
      this.onClose();
    };
    this.keepalive = window.setInterval(() => this.sendRaw({ t: 'ping' }), KEEPALIVE_MS);
  }

  static async connect(url: string, opts: ClientOptions): Promise<SignalClient> {
    const ws = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}app=${encodeURIComponent(opts.app)}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new SignalError('Could not reach the signaling server.'));
    });
    const c = new SignalClient(ws, opts);
    const hello = c.wait('hello');
    ws.send('{"t":"hello"}');
    c.id = ((await hello) as { id: string }).id;
    return c;
  }

  close(): void {
    clearInterval(this.keepalive);
    this.ws.close();
  }

  /** Games hosted on this network (by other connections of this app). */
  async list(): Promise<RoomInfo[]> {
    const r = this.wait('rooms');
    this.sendRaw({ t: 'list' });
    return ((await r) as { rooms: RoomInfo[] }).rooms;
  }

  /** Host a game. Joiners appear through `onPeer` once connected. */
  async host(opts: HostOptions): Promise<HostedRoom> {
    const key = opts.passphrase ? await deriveKey(opts.passphrase, this.opts.app, this.id) : null;
    const r = this.wait('hosted');
    this.sendRaw({ t: 'host', name: opts.name, locked: !!key, meta: opts.meta ?? null });
    const room = new HostedRoom(this, ((await r) as { room: RoomInfo }).room, key, opts);
    this.onPeerJoin = (peer) => room.accept(peer);
    return room;
  }

  /** Join a hosted game; resolves with the connected peer connection to the host. */
  async join(roomId: string, opts: JoinOptions = {}): Promise<RTCPeerConnection> {
    const joined = this.wait('joined');
    this.sendRaw({ t: 'join', room: roomId });
    const room = ((await joined) as { room: RoomInfo }).room;
    if (room.locked && !opts.passphrase) throw new SignalError('This game needs a passphrase.');
    const key = room.locked ? await deriveKey(opts.passphrase!, this.opts.app, room.id) : null;
    const pc = this.newPeerConnection(opts);
    const ch = new PeerChannel(this, room.id, key);
    const done = connected(pc, this.opts, opts.timeoutMs ?? 20_000);
    ch.onMessage = async (m) => {
      if (m.k === 'denied') return fail(pc, new SignalError('Wrong passphrase.'));
      if (m.k === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await ch.send({ k: 'answer', sdp: pc.localDescription!.sdp });
      } else if (m.k === 'ice') await pc.addIceCandidate(m.c).catch(() => {});
    };
    this.trickle(pc, ch);
    await ch.send({ k: 'hello' });
    try {
      return await done;
    } finally {
      ch.dispose();
    }
  }

  /** Stop advertising a hosted game (connected peers stay connected). */
  unhost(): void {
    this.onPeerJoin = null;
    this.sendRaw({ t: 'unhost' });
  }

  /** Update a hosted game's listing (name, meta). */
  update(name: string, locked: boolean, meta: unknown): void {
    this.sendRaw({ t: 'host', name, locked, meta });
  }

  // ---- internals ----

  newPeerConnection(opts: PeerOptions): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? [] });
    opts.setup?.(pc);
    return pc;
  }

  /** Send our ICE candidates as they appear (only LAN ones unless the internet is allowed). */
  trickle(pc: RTCPeerConnection, ch: PeerChannel): void {
    pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      if (!this.opts.allowInternet && candidateType(e.candidate.candidate) !== 'host') return;
      void ch.send({ k: 'ice', c: e.candidate.toJSON() });
    };
  }

  onSignal(peer: string, fn: ((data: unknown) => void) | null): void {
    if (fn) this.peerHandlers.set(peer, fn);
    else this.peerHandlers.delete(peer);
  }

  sendRaw(m: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private wait(t: ServerMsg['t']): Promise<ServerMsg> {
    return new Promise((resolve, reject) => this.waiters.push({ t, resolve, reject }));
  }

  private receive(m: ServerMsg): void {
    if (m.t === 'error') {
      const w = this.waiters.shift();
      if (w) w.reject(new SignalError(m.message));
      return;
    }
    if (m.t === 'peer') return void this.onPeerJoin?.(m.peer);
    if (m.t === 'signal') return void this.peerHandlers.get(m.from)?.(m.data);
    const i = this.waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
  }
}

/** A hosted game: accepts joiners and hands over their connections. */
export class HostedRoom {
  /** A joiner connected (over the LAN, with the right passphrase). */
  onPeer: (pc: RTCPeerConnection, peerId: string) => void = () => {};
  /** A joiner tried and failed (wrong passphrase, not on the LAN, timed out). */
  onPeerFailed: (peerId: string, reason: string) => void = () => {};

  private readonly sig: SignalClient;
  readonly info: RoomInfo;
  private readonly key: CryptoKey | null;
  private readonly opts: HostOptions;

  constructor(sig: SignalClient, info: RoomInfo, key: CryptoKey | null, opts: HostOptions) {
    this.sig = sig;
    this.info = info;
    this.key = key;
    this.opts = opts;
  }

  /** Update the listing (e.g. player count in meta). */
  update(meta: unknown): void {
    this.sig.update(this.info.name, this.info.locked, meta);
  }

  close(): void {
    this.sig.unhost();
  }

  /** @internal A joiner arrived: wait for its hello, then offer. */
  accept(peer: string): void {
    const ch = new PeerChannel(this.sig, peer, this.key);
    let pc: RTCPeerConnection | null = null;
    ch.onUndecryptable = () => {
      void ch.sendPlain({ k: 'denied' });
      ch.dispose();
      this.onPeerFailed(peer, 'wrong passphrase');
    };
    ch.onMessage = async (m) => {
      if (m.k === 'hello' && !pc) {
        pc = this.sig.newPeerConnection(this.opts);
        const conn = pc;
        this.sig.trickle(conn, ch);
        connected(conn, this.sig.opts, 20_000).then(
          () => {
            ch.dispose();
            this.onPeer(conn, peer);
          },
          (e: unknown) => {
            ch.dispose();
            this.onPeerFailed(peer, e instanceof Error ? e.message : String(e));
          },
        );
        await conn.setLocalDescription(await conn.createOffer());
        await ch.send({ k: 'offer', sdp: conn.localDescription!.sdp });
      } else if (m.k === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      else if (m.k === 'ice' && pc) await pc.addIceCandidate(m.c).catch(() => {});
    };
  }
}

/** Messages to one peer through the relay, encrypted with the room key if there is one. */
class PeerChannel {
  onMessage: (m: PeerMsg) => void | Promise<void> = () => {};
  onUndecryptable: () => void = () => {};
  private chain: Promise<unknown> = Promise.resolve();

  private readonly sig: SignalClient;
  private readonly peer: string;
  private readonly key: CryptoKey | null;

  constructor(sig: SignalClient, peer: string, key: CryptoKey | null) {
    this.sig = sig;
    this.peer = peer;
    this.key = key;
    sig.onSignal(peer, (data) => {
      // In order: an answer must not overtake its offer, nor candidates their description.
      this.chain = this.chain.then(async () => {
        const m = await this.open(data);
        if (m) await this.onMessage(m);
      }).catch(() => {});
    });
  }

  async send(m: PeerMsg): Promise<void> {
    this.sig.sendRaw({ t: 'signal', to: this.peer, data: this.key ? await encrypt(this.key, m) : m });
  }

  /** Unencrypted (only to refuse a joiner with the wrong passphrase). */
  async sendPlain(m: PeerMsg): Promise<void> {
    this.sig.sendRaw({ t: 'signal', to: this.peer, data: m });
  }

  dispose(): void {
    this.sig.onSignal(this.peer, null);
  }

  private async open(data: unknown): Promise<PeerMsg | null> {
    const d = data as { enc?: string; k?: string };
    if (d?.k === 'denied') return { k: 'denied' };
    if (!this.key) return d?.k ? (d as PeerMsg) : null;
    if (typeof d?.enc !== 'string') {
      this.onUndecryptable();
      return null;
    }
    try {
      return await decrypt(this.key, d.enc);
    } catch {
      this.onUndecryptable();
      return null;
    }
  }
}

// ---- connection checks ----

/** The candidate type in an ICE candidate line ('host', 'srflx', 'relay', 'prflx'). */
export function candidateType(line: string): string {
  return /\btyp (\w+)/.exec(line)?.[1] ?? '';
}

/** A LAN address: private IPv4, link-local, unique-local IPv6, loopback, or a hidden mDNS name (shown as '' in stats). */
export function isLocalAddress(a: string | undefined): boolean {
  if (!a || a.endsWith('.local')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a) || /^127\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const v6 = a.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

/** Wait for the connection, then insist (unless the internet is allowed) that its route is LAN to LAN. */
function connected(pc: RTCPeerConnection, opts: ClientOptions, timeoutMs: number): Promise<RTCPeerConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(pc, new SignalError(
      'Could not connect over the network. Check both computers are on the same network (not guest Wi-Fi, no client isolation, no VPN).',
    )), timeoutMs);
    const settle = (e: Error | null): void => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      if (e) reject(e);
      else resolve(pc);
    };
    (pc as { __fail?: (e: Error) => void }).__fail = (e) => {
      settle(e);
      pc.close();
    };
    const check = async (): Promise<void> => {
      if (pc.connectionState === 'failed') return fail(pc, new SignalError('The connection failed.'));
      if (pc.connectionState !== 'connected') return;
      if (!opts.allowInternet && !(await lanRoute(pc))) return fail(pc, new SignalError('That connection was not over the local network, so it was refused.'));
      settle(null);
    };
    pc.addEventListener('connectionstatechange', () => void check());
  });
}

function fail(pc: RTCPeerConnection, e: Error): void {
  (pc as { __fail?: (e: Error) => void }).__fail?.(e);
}

/** The selected candidate pair joins two local addresses. */
export async function lanRoute(pc: RTCPeerConnection): Promise<boolean> {
  const stats = await pc.getStats();
  let pairId = '';
  stats.forEach((s: { type: string; selectedCandidatePairId?: string; nominated?: boolean; state?: string; id: string }) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  });
  if (!pairId) stats.forEach((s: { type: string; nominated?: boolean; state?: string; id: string }) => {
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id;
  });
  const pair = stats.get(pairId) as { localCandidateId: string; remoteCandidateId: string } | undefined;
  if (!pair) return false;
  const ok = (id: string): boolean => {
    const c = stats.get(id) as { candidateType?: string; address?: string } | undefined;
    return !!c && c.candidateType !== 'relay' && c.candidateType !== 'srflx' && isLocalAddress(c.address);
  };
  return ok(pair.localCandidateId) && ok(pair.remoteCandidateId);
}

// ---- passphrase encryption ----

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-GCM key from a passphrase, salted with the app and room so keys never repeat across rooms. */
export async function deriveKey(passphrase: string, app: string, room: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(`lan-signal|${app}|${room}`), iterations: 100_000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key: CryptoKey, m: unknown): Promise<{ enc: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(m))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return { enc: b64(out) };
}

export async function decrypt<T>(key: CryptoKey, enc: string): Promise<T> {
  const bytes = unb64(enc);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
