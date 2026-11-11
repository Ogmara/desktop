/**
 * Peer nodes for split detection — unified peer rule, sources, URL filter
 * (desktop 1.85.0). Run:
 *   node --conditions=browser --test src/lib/epochPeers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyCommitmentInfo } from '@ogmara/sdk';
import {
  peerErrorKind, queryPeerCommitments, isPrivateHostLiteral, normalizePeerUrl, selectPeerCandidates,
  probePeers, markNoRedirect, isNoRedirect, MAX_PEER_CANDIDATES,
} from './epochPeers.ts';

const http = (s: number) => new Error(`API error (${s}): x`);
const ans = (e: number): KeyCommitmentInfo => ({ channel_id: 9, epoch: e, state: 'none', final: false, finality_ms: 120000 });

test('peerErrorKind: 403/404 skip; 401, 5xx, timeout, network, malformed fail', () => {
  assert.equal(peerErrorKind(http(404)), 'skip');
  assert.equal(peerErrorKind(http(403)), 'skip');
  assert.equal(peerErrorKind({ status: 404 }), 'skip');
  for (const e of [http(401), http(500), http(503), new Error('The operation was aborted'), new TypeError('fetch failed'), 'x']) {
    assert.equal(peerErrorKind(e), 'fail');
  }
});

test('unified peer rule', async () => {
  assert.deepEqual(await queryPeerCommitments([], async () => ans(1)), [], 'no peers');
  assert.deepEqual(await queryPeerCommitments(['a', 'b'], async () => { throw http(404); }), [], 'every peer skipped');
  await assert.rejects(queryPeerCommitments(['a', 'b'], async (p) => { throw p === 'a' ? http(404) : new Error('timeout'); }), 'no answer + a failure');
  await assert.rejects(queryPeerCommitments(['a'], async () => { throw http(401); }));
  const r = await queryPeerCommitments(['a', 'b', 'c'], async (p) => {
    if (p === 'a') throw http(503);
    if (p === 'b') throw http(404);
    return ans(2);
  });
  assert.equal(r.length, 1, 'answers counted, failures ignored once something answered');
});

test('private / loopback / link-local literals', () => {
  for (const h of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateHostLiteral(h), true, h);
  }
  for (const h of ['8.8.8.8', '172.32.0.1', 'node.example.org', '2001:db8::1']) assert.equal(isPrivateHostLiteral(h), false, h);
});

test('peer URLs: registry entries must be public https; user-configured ones may be LAN; never credentials', () => {
  assert.equal(normalizePeerUrl('https://n.example.org/api/x', false), 'https://n.example.org');
  assert.equal(normalizePeerUrl('http://n.example.org', false), null);
  assert.equal(normalizePeerUrl('https://192.168.1.5:41721', false), null);
  assert.equal(normalizePeerUrl('http://192.168.1.5:41721', true), 'http://192.168.1.5:41721');
  assert.equal(normalizePeerUrl('https://u:p@n.example.org', true), null);
  assert.equal(normalizePeerUrl('ftp://n.example.org', true), null);
  assert.equal(normalizePeerUrl('not a url', true), null);
});

test('candidates: known nodes first, then the registry; home excluded; deduped; capped at 8', () => {
  const c = selectPeerCandidates({
    known: ['https://home.example.org/', 'http://192.168.1.5:41721', 'https://a.example.org'],
    registry: ['https://a.example.org', 'https://10.0.0.1', ...Array.from({ length: 20 }, (_, i) => `https://r${i}.example.org`)],
    home: 'https://home.example.org',
  });
  assert.deepEqual(c.slice(0, 3), ['http://192.168.1.5:41721', 'https://a.example.org', 'https://r0.example.org']);
  assert.equal(c.length, MAX_PEER_CANDIDATES);
  assert.ok(!c.includes('https://home.example.org') && !c.includes('https://10.0.0.1'));
});

test('probe: only same-network nodes with key_commitment_v1; dead ones dropped; max 3', async () => {
  const health: Record<string, { network?: string; features?: unknown }> = {
    a: { network: 'testnet', features: ['key_commitment_v1'] },
    b: { network: 'mainnet', features: ['key_commitment_v1'] },
    c: { network: 'testnet', features: [] },
    e: { network: 'testnet', features: ['key_commitment_v1'] },
    f: { network: 'testnet', features: ['key_commitment_v1'] },
    g: { network: 'testnet', features: ['key_commitment_v1'] },
  };
  const r = await probePeers(['a', 'b', 'c', 'd', 'e', 'f', 'g'], async (u) => {
    if (!health[u]) throw new Error('down');
    return health[u]!;
  }, 'testnet', 'key_commitment_v1');
  assert.deepEqual(r, ['a', 'e', 'f']);
});

test('no-redirect registry is per origin', () => {
  markNoRedirect('https://peer.example.org/x');
  assert.equal(isNoRedirect('https://peer.example.org/api/v1/health'), true);
  assert.equal(isNoRedirect('https://other.example.org/'), false);
  assert.equal(isNoRedirect('garbage'), false);
});

test('the global fetch wrapper turns redirects off for registered peer origins', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');
  assert.match(src, /return \(tauriFetch as any\)\(input, isNoRedirect\(url\) \? \{ \.\.\.init, maxRedirections: 0 \} : init\);/);
  assert.match(src, /\.\.\.\(isNoRedirect\(url\) \? \{ maxRedirections: 0 \} : \{\}\)/);
});

test('URL filter hardening: ::/96, NAT64, trailing dots, multicast, site-local', () => {
  for (const h of ['[::a00:1]', '::a00:1', '64:ff9b::102:304', 'localhost.', 'LOCALHOST..', '224.0.0.1', '239.255.255.250', '255.255.255.255', 'fec0::1', 'feff::1', 'ff02::1']) {
    assert.equal(isPrivateHostLiteral(h), true, h);
  }
  assert.equal(normalizePeerUrl('https://[::10.0.0.1]', false), null);
  assert.equal(normalizePeerUrl('https://localhost./', false), null);
  assert.equal(normalizePeerUrl('https://node.example.org./x', false), 'https://node.example.org', 'trailing dot stripped');
});

test('no-redirect registry fails CLOSED when full: that peer is refused', async () => {
  const { resetNoRedirectForTests } = await import('./epochPeers.ts');
  resetNoRedirectForTests();
  for (let i = 0; i < 64; i++) assert.equal(markNoRedirect(`https://p${i}.example.org`), true);
  assert.equal(markNoRedirect('https://p0.example.org/again'), true, 'an already registered origin is fine');
  assert.equal(markNoRedirect('https://one-too-many.example.org'), false);
  assert.equal(isNoRedirect('https://one-too-many.example.org/'), false);
  assert.equal(markNoRedirect('not a url'), false);
  resetNoRedirectForTests();
});
