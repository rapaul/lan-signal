import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MemoryStore, Relay, RelayError, originAllowed } from '../core/relay.ts';
import type { ServerMsg } from '../core/relay.ts';

function setup(now = 1000) {
  const inbox = new Map<string, ServerMsg[]>();
  const gone = new Set<string>();
  const send = async (id: string, msg: ServerMsg) => {
    if (gone.has(id)) return false;
    inbox.set(id, [...(inbox.get(id) ?? []), msg]);
    return true;
  };
  const store = new MemoryStore();
  let t = now;
  const relay = new Relay(store, send, () => t);
  const last = (id: string) => inbox.get(id)?.at(-1);
  return { relay, store, inbox, gone, last, tick: (s: number) => (t += s) };
}

describe('relay', () => {
  it('lists rooms only to the same app on the same network', async () => {
    const { relay, last } = setup();
    await relay.connect('host', 'game-a', '1.2.3.4');
    await relay.connect('friend', 'game-a', '1.2.3.4');
    await relay.connect('stranger', 'game-a', '9.9.9.9');
    await relay.connect('other-app', 'game-b', '1.2.3.4');
    await relay.message('host', JSON.stringify({ t: 'host', name: 'Ann', locked: true, meta: { map: 'kauai' } }));
    expect(last('host')).toEqual({ t: 'hosted', room: { id: 'host', name: 'Ann', locked: true, meta: { map: 'kauai' } } });
    for (const id of ['friend', 'stranger', 'other-app']) await relay.message(id, '{"t":"list"}');
    expect(last('friend')).toMatchObject({ t: 'rooms', rooms: [{ id: 'host', name: 'Ann' }] });
    expect(last('stranger')).toEqual({ t: 'rooms', rooms: [] });
    expect(last('other-app')).toEqual({ t: 'rooms', rooms: [] });
  });

  it('join tells the host and the joiner; signals pass only within the network', async () => {
    const { relay, last } = setup();
    await relay.connect('host', 'g', '1.2.3.4');
    await relay.connect('friend', 'g', '1.2.3.4');
    await relay.connect('stranger', 'g', '5.5.5.5');
    await relay.message('host', '{"t":"host","name":"Ann"}');
    await relay.message('friend', '{"t":"join","room":"host"}');
    expect(last('host')).toEqual({ t: 'peer', peer: 'friend' });
    expect(last('friend')).toMatchObject({ t: 'joined', room: { id: 'host' } });
    await relay.message('friend', JSON.stringify({ t: 'signal', to: 'host', data: { k: 'hello' } }));
    expect(last('host')).toEqual({ t: 'signal', from: 'friend', data: { k: 'hello' } });
    await relay.message('stranger', '{"t":"join","room":"host"}');
    expect(last('stranger')).toEqual({ t: 'error', message: 'That game is no longer open.' });
    await relay.message('stranger', JSON.stringify({ t: 'signal', to: 'host', data: 'x' }));
    expect(last('stranger')).toEqual({ t: 'error', message: 'peer not found' });
    expect(last('host')).toEqual({ t: 'signal', from: 'friend', data: { k: 'hello' } });
  });

  it('unhost and disconnect remove the room; a vanished host is cleaned up', async () => {
    const { relay, last, gone, store } = setup();
    await relay.connect('host', 'g', 'ip');
    await relay.connect('friend', 'g', 'ip');
    await relay.message('host', '{"t":"host","name":"A"}');
    await relay.message('host', '{"t":"unhost"}');
    await relay.message('friend', '{"t":"list"}');
    expect(last('friend')).toEqual({ t: 'rooms', rooms: [] });
    await relay.message('host', '{"t":"host","name":"A"}');
    gone.add('host');
    await relay.message('friend', '{"t":"join","room":"host"}');
    expect(last('friend')).toEqual({ t: 'error', message: 'That game is no longer open.' });
    expect(await store.get('host')).toBeNull();
    await relay.disconnect('friend');
    expect(await store.get('friend')).toBeNull();
  });

  it('expired records are ignored; activity extends them', async () => {
    const { relay, last, tick } = setup();
    await relay.connect('host', 'g', 'ip');
    await relay.connect('friend', 'g', 'ip');
    await relay.message('host', '{"t":"host","name":"A"}');
    tick(DEFAULT_LIMITS.ttlSeconds - 10);
    await relay.message('host', '{"t":"ping"}');
    expect(last('host')).toEqual({ t: 'pong' });
    tick(20);
    await relay.message('friend', '{"t":"list"}');
    expect(last('friend')).toMatchObject({ rooms: [{ id: 'host' }] });
    tick(DEFAULT_LIMITS.ttlSeconds + 1);
    await relay.connect('late', 'g', 'ip');
    await relay.message('late', '{"t":"list"}');
    expect(last('late')).toEqual({ t: 'rooms', rooms: [] });
  });

  it('rejects bad input: app ids, junk, oversized messages and meta', async () => {
    const { relay, last } = setup();
    await expect(relay.connect('x', 'Bad App!', 'ip')).rejects.toThrow(RelayError);
    await expect(relay.connect('x', 'ok', '')).rejects.toThrow(RelayError);
    await relay.connect('a', 'g', 'ip');
    await relay.message('a', 'not json');
    expect(last('a')).toEqual({ t: 'error', message: 'not JSON' });
    await relay.message('a', JSON.stringify({ t: 'host', name: 'x', meta: 'm'.repeat(2000) }));
    expect(last('a')).toEqual({ t: 'error', message: 'room meta too large' });
    await relay.message('a', 'x'.repeat(DEFAULT_LIMITS.maxMessage + 1));
    expect(last('a')).toEqual({ t: 'error', message: 'message too large' });
    await relay.message('a', '{"t":"nope"}');
    expect(last('a')).toEqual({ t: 'error', message: 'unknown message' });
    await relay.message('a', JSON.stringify({ t: 'host', name: '   ' }));
    expect(last('a')).toMatchObject({ t: 'hosted', room: { name: 'Game' } });
    await relay.hello('a');
    expect(last('a')).toEqual({ t: 'hello', id: 'a' });
  });

  it('origins: listed, wildcard, or localhost when allowed', () => {
    expect(originAllowed('https://example.com', 'https://example.com')).toBe(true);
    expect(originAllowed('https://evil.example', 'https://example.com')).toBe(false);
    expect(originAllowed('http://localhost:5173', 'https://example.com')).toBe(false);
    expect(originAllowed('http://localhost:5173', 'https://example.com,localhost')).toBe(true);
    expect(originAllowed('https://anything', '*')).toBe(true);
    expect(originAllowed(undefined, '*')).toBe(false);
  });
});
