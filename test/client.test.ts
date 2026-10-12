import { describe, expect, it } from 'vitest';
import { candidateType, decrypt, deriveKey, encrypt, isLocalAddress } from '../client/index.ts';

describe('client helpers', () => {
  it('classifies candidates and addresses', () => {
    expect(candidateType('candidate:1 1 udp 2122260223 192.168.1.2 4000 typ host generation 0')).toBe('host');
    expect(candidateType('candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0')).toBe('srflx');
    for (const a of ['192.168.1.2', '10.0.0.1', '172.16.5.5', '172.31.0.1', '169.254.1.1', 'fe80::1', 'fd12::3', 'abc.local', '', undefined]) expect(isLocalAddress(a), String(a)).toBe(true);
    for (const a of ['203.0.113.9', '172.32.0.1', '8.8.8.8', '2001:db8::1']) expect(isLocalAddress(a), a).toBe(false);
  });

  it('passphrase encryption round-trips; the wrong passphrase or room fails', async () => {
    const key = await deriveKey('spades', 'game', 'room1');
    const box = await encrypt(key, { k: 'hello' });
    expect(await decrypt(key, box.enc)).toEqual({ k: 'hello' });
    await expect(decrypt(await deriveKey('clubs', 'game', 'room1'), box.enc)).rejects.toThrow();
    await expect(decrypt(await deriveKey('spades', 'game', 'room2'), box.enc)).rejects.toThrow();
  });
});
