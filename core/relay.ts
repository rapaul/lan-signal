/**
 * The signaling relay, independent of where it runs (AWS Lambda or the
 * local Node server). It knows nothing about any game: it holds who is
 * connected, which connections host a room, and passes opaque `signal`
 * payloads between connections.
 *
 * Rooms are grouped by app and public IP: a client only ever sees, joins or
 * signals connections from the same app behind the same public address,
 * which in practice means the same home or office network. Game traffic
 * never comes here; only the few setup messages do.
 */

/** Public info about a hosted room, as listed to other clients. */
export interface RoomInfo {
  /** The host's connection id. */
  id: string;
  name: string;
  /** Joining needs a passphrase (checked between the peers, not here). */
  locked: boolean;
  /** Small app-defined JSON (mode, map, player count...). */
  meta: unknown;
}

export interface Connection {
  id: string;
  /** `${app}|${ip}`: who can see whom. */
  group: string;
  room: RoomInfo | null;
  /** Unix seconds after which the record may be discarded (store TTL). */
  expires: number;
}

/** Where connections live (DynamoDB, or a Map locally). */
export interface Store {
  get(id: string): Promise<Connection | null>;
  put(c: Connection): Promise<void>;
  delete(id: string): Promise<void>;
  inGroup(group: string): Promise<Connection[]>;
}

/** Delivers a message to a connection; resolves false if it has gone. */
export type Send = (id: string, msg: ServerMsg) => Promise<boolean>;

export type ClientMsg =
  | { t: 'host'; name: string; locked?: boolean; meta?: unknown }
  | { t: 'unhost' }
  | { t: 'list' }
  | { t: 'join'; room: string }
  | { t: 'signal'; to: string; data: unknown }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'hello'; id: string }
  | { t: 'hosted'; room: RoomInfo }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'joined'; room: RoomInfo }
  | { t: 'peer'; peer: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'pong' }
  | { t: 'error'; message: string };

export interface RelayLimits {
  /** Largest accepted message, bytes of JSON. */
  maxMessage: number;
  /** Largest room `meta`, bytes of JSON. */
  maxMeta: number;
  /** Seconds a connection record lives without activity. */
  ttlSeconds: number;
}

export const DEFAULT_LIMITS: RelayLimits = { maxMessage: 16 * 1024, maxMeta: 1024, ttlSeconds: 2 * 60 * 60 };

/** App ids: lower-case letters, digits and dashes. */
export const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class RelayError extends Error {}

export class Relay {
  // Plain fields, not constructor parameter properties: Node runs this file with type stripping only.
  private readonly store: Store;
  private readonly send: Send;
  private readonly now: () => number;
  private readonly limits: RelayLimits;

  constructor(store: Store, send: Send, now: () => number = () => Date.now() / 1000, limits: RelayLimits = DEFAULT_LIMITS) {
    this.store = store;
    this.send = send;
    this.now = now;
    this.limits = limits;
  }

  /** A new connection from `ip` for `app`. Throws RelayError to refuse it. */
  async connect(id: string, app: string, ip: string): Promise<void> {
    if (!APP_ID.test(app)) throw new RelayError('bad app id');
    if (!ip) throw new RelayError('no source address');
    await this.store.put({ id, group: `${app}|${ip}`, room: null, expires: this.expiry() });
  }

  /** Greeting sent once the socket can receive (AWS can't send during $connect). */
  async hello(id: string): Promise<void> {
    await this.deliver(id, { t: 'hello', id });
  }

  async disconnect(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /** Handle one raw message from connection `id`. */
  async message(id: string, raw: string): Promise<void> {
    const me = await this.store.get(id);
    if (!me) return;
    if (raw.length > this.limits.maxMessage) return void (await this.deliver(id, { t: 'error', message: 'message too large' }));
    let m: ClientMsg;
    try {
      m = JSON.parse(raw) as ClientMsg;
    } catch {
      return void (await this.deliver(id, { t: 'error', message: 'not JSON' }));
    }
    me.expires = this.expiry();
    switch (m?.t) {
      case 'ping':
        await this.store.put(me);
        await this.deliver(id, { t: 'pong' });
        return;
      case 'host': {
        const name = String(m.name ?? '').trim().slice(0, 40) || 'Game';
        const meta = m.meta ?? null;
        if (JSON.stringify(meta).length > this.limits.maxMeta) return void (await this.deliver(id, { t: 'error', message: 'room meta too large' }));
        me.room = { id, name, locked: !!m.locked, meta };
        await this.store.put(me);
        await this.deliver(id, { t: 'hosted', room: me.room });
        return;
      }
      case 'unhost':
        me.room = null;
        await this.store.put(me);
        return;
      case 'list': {
        await this.store.put(me);
        const rooms = (await this.store.inGroup(me.group)).filter((c) => c.room && c.id !== id && c.expires > this.now()).map((c) => c.room!);
        await this.deliver(id, { t: 'rooms', rooms });
        return;
      }
      case 'join': {
        const host = await this.peerInGroup(me, String(m.room));
        if (!host?.room) return void (await this.deliver(id, { t: 'error', message: 'That game is no longer open.' }));
        await this.store.put(me);
        if (!(await this.deliver(host.id, { t: 'peer', peer: id }))) return void (await this.deliver(id, { t: 'error', message: 'That game is no longer open.' }));
        await this.deliver(id, { t: 'joined', room: host.room });
        return;
      }
      case 'signal': {
        const to = await this.peerInGroup(me, String(m.to));
        if (!to) return void (await this.deliver(id, { t: 'error', message: 'peer not found' }));
        await this.deliver(to.id, { t: 'signal', from: id, data: m.data });
        return;
      }
      default:
        await this.deliver(id, { t: 'error', message: 'unknown message' });
    }
  }

  /** Another live connection in the same group (never across networks or apps). */
  private async peerInGroup(me: Connection, other: string): Promise<Connection | null> {
    if (other === me.id) return null;
    const c = await this.store.get(other);
    return c && c.group === me.group && c.expires > this.now() ? c : null;
  }

  private async deliver(id: string, msg: ServerMsg): Promise<boolean> {
    const ok = await this.send(id, msg);
    if (!ok) await this.store.delete(id);
    return ok;
  }

  private expiry(): number {
    return Math.floor(this.now()) + this.limits.ttlSeconds;
  }
}

/** In-memory store (local server, tests). */
export class MemoryStore implements Store {
  private readonly conns = new Map<string, Connection>();

  async get(id: string): Promise<Connection | null> {
    const c = this.conns.get(id);
    return c ? structuredClone(c) : null;
  }

  async put(c: Connection): Promise<void> {
    this.conns.set(c.id, structuredClone(c));
  }

  async delete(id: string): Promise<void> {
    this.conns.delete(id);
  }

  async inGroup(group: string): Promise<Connection[]> {
    return [...this.conns.values()].filter((c) => c.group === group).map((c) => structuredClone(c));
  }
}

/**
 * Is `origin` allowed? `allowed` is a comma-separated list of origins;
 * '*' allows any, and the word 'localhost' allows any localhost port (dev).
 */
export function originAllowed(origin: string | undefined, allowed: string): boolean {
  if (!origin) return false;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*') || list.includes(origin)) return true;
  return list.includes('localhost') && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
