/**
 * Local signaling server (development, end-to-end tests, or a LAN box):
 * the same relay as the Lambda, over the `ws` package, with connections in
 * memory. Everyone connecting from this machine counts as one network.
 *
 *   node server/local.ts [port]        # default 8787, any origin
 *   ALLOWED_ORIGINS=https://x.example node server/local.ts
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { MemoryStore, Relay, RelayError, originAllowed } from '../core/relay.ts';
import type { ServerMsg } from '../core/relay.ts';

export interface LocalServer {
  port: number;
  close(): Promise<void>;
}

export function startLocalServer(port = 8787, allowedOrigins = process.env.ALLOWED_ORIGINS ?? '*'): Promise<LocalServer> {
  const sockets = new Map<string, WebSocket>();
  const send = async (id: string, msg: ServerMsg): Promise<boolean> => {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };
  const relay = new Relay(new MemoryStore(), send);
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws, req) => {
    const id = randomUUID();
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!originAllowed(req.headers.origin ?? 'http://localhost', allowedOrigins)) return ws.close(1008, 'origin not allowed');
    // Loopback and LAN addresses all count as this machine's network.
    const ip = 'local';
    sockets.set(id, ws);
    // Serialise each connection's messages, as API Gateway effectively does per connection.
    let chain: Promise<unknown> = relay.connect(id, url.searchParams.get('app') ?? '', ip).catch((e: unknown) => {
      ws.close(1008, e instanceof RelayError ? e.message : 'error');
    });
    ws.on('message', (data) => {
      const text = data.toString();
      chain = chain.then(() => (text === '{"t":"hello"}' ? relay.hello(id) : relay.message(id, text))).catch((e: unknown) => console.error(e));
    });
    ws.on('close', () => {
      sockets.delete(id);
      chain = chain.then(() => relay.disconnect(id));
    });
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise<void>((done) => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => done());
        }),
      });
    });
  });
}

// Run directly (also through a node_modules symlink): start listening.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startLocalServer(Number(process.argv[2] ?? 8787));
  console.log(`lan-signal listening on ws://localhost:${s.port}`);
}
