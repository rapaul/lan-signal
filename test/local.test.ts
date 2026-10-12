import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalServer } from '../server/local.ts';
import type { LocalServer } from '../server/local.ts';

let server: LocalServer;
beforeAll(async () => {
  server = await startLocalServer(0, 'localhost');
});
afterAll(() => server.close());

function client(app: string, origin = 'http://localhost:5173'): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/?app=${app}`, { headers: { origin } } as never);
  const queue: Record<string, unknown>[] = [];
  const waiting: ((m: Record<string, unknown>) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Record<string, unknown>;
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  };
  const next = () => new Promise<Record<string, unknown>>((r) => (queue.length ? r(queue.shift()!) : waiting.push(r)));
  return new Promise((resolve) => (ws.onopen = () => resolve({ ws, next })));
}

describe('local server', () => {
  it('relays a host and a joiner end to end', async () => {
    const a = await client('test');
    a.ws.send('{"t":"hello"}');
    const { id: hostId } = await a.next();
    a.ws.send(JSON.stringify({ t: 'host', name: 'Ann' }));
    expect(await a.next()).toMatchObject({ t: 'hosted' });
    const b = await client('test');
    b.ws.send('{"t":"hello"}');
    await b.next();
    b.ws.send('{"t":"list"}');
    expect(await b.next()).toMatchObject({ t: 'rooms', rooms: [{ id: hostId, name: 'Ann' }] });
    b.ws.send(JSON.stringify({ t: 'join', room: hostId }));
    expect(await a.next()).toMatchObject({ t: 'peer' });
    expect(await b.next()).toMatchObject({ t: 'joined' });
    a.ws.close();
    b.ws.close();
  });
});
