import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PiholeClient } from '../../pihole-client.js';
import type { ToolDef } from '../../tools.js';

interface Seen { method: string; url: string; body: any }

let server: http.Server;
let client: PiholeClient;
let toolDefs: ToolDef[];
let seen: Seen[] = [];
// Existing adlist the fake serves for the read-modify-write on update.
const existing: any = { address: 'https://x.example/l.txt', type: 'block', comment: 'keep me', groups: [0, 2], enabled: false };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/auth' && req.method === 'POST') {
        res.end(JSON.stringify({ session: { valid: true, sid: 'sid-1', csrf: 'c' } }));
        return;
      }
      seen.push({ method: req.method!, url: req.url!, body });
      if (req.method === 'GET' && req.url!.startsWith('/api/lists/')) {
        res.end(JSON.stringify({ lists: [existing] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  client = new PiholeClient({ name: 'fake', baseUrl, password: 'unit-test-only', insecureTLS: false });
  // tools.ts reads the instance config at import time, so set it first.
  process.env.PIHOLE_INSTANCES = 'fake';
  process.env.FAKE_BASE_URL = baseUrl;
  process.env.FAKE_PASSWORD = 'unit-test-only';
  ({ toolDefs } = await import('../../tools.js'));
});
after(() => { server.close(); });
beforeEach(() => { seen = []; });

describe('PiholeClient.stats', () => {
  test('maps each kind to its endpoint', async () => {
    const paths: Record<string, string> = {
      upstreams: '/api/stats/upstreams', query_types: '/api/stats/query_types', history: '/api/history',
    };
    for (const [kind, path] of Object.entries(paths)) {
      await client.stats(kind as any);
      assert.equal(seen.at(-1)!.url, path);
    }
  });

  test('count and blocked become query parameters; history_clients uses N', async () => {
    await client.stats('top_domains', { count: 5, blocked: true });
    assert.equal(seen.at(-1)!.url, '/api/stats/top_domains?blocked=true&count=5');
    await client.stats('history_clients', { count: 0 });
    assert.equal(seen.at(-1)!.url, '/api/history/clients?N=0');
    await client.stats('recent_blocked', { count: 3 });
    assert.equal(seen.at(-1)!.url, '/api/stats/recent_blocked?count=3');
  });

  test('rejects unsupported parameters instead of dropping them', async () => {
    await assert.rejects(client.stats('upstreams', { blocked: true }), /blocked is only supported/);
    await assert.rejects(client.stats('recent_blocked', { blocked: false }), /blocked is only supported/);
    await assert.rejects(client.stats('history', { count: 1 }), /count is not supported/);
    await assert.rejects(client.stats('nope' as any), /unknown stats kind/);
    assert.equal(seen.length, 0, 'nothing should reach the server');
  });
});

describe('PiholeClient.blockingStatus', () => {
  test('GETs /api/dns/blocking', async () => {
    await client.blockingStatus();
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/api/dns/blocking', body: undefined });
  });
});

describe('PiholeClient.adlists', () => {
  test('list, with and without a type filter', async () => {
    await client.adlists('list');
    assert.equal(seen.at(-1)!.url, '/api/lists');
    await client.adlists('list', { type: 'allow' });
    assert.equal(seen.at(-1)!.url, '/api/lists?type=allow');
  });

  test('add applies defaults (block, group 0, enabled, null comment)', async () => {
    await client.adlists('add', { address: 'https://x.example/l.txt' });
    assert.deepEqual(seen.at(-1), {
      method: 'POST', url: '/api/lists?type=block',
      body: { address: 'https://x.example/l.txt', comment: null, groups: [0], enabled: true },
    });
  });

  test('update reads first and keeps omitted fields', async () => {
    await client.adlists('update', { address: 'https://x.example/l.txt', type: 'block', enabled: true });
    assert.equal(seen[0].method, 'GET');
    assert.deepEqual(seen[1], {
      method: 'PUT', url: '/api/lists/https%3A%2F%2Fx.example%2Fl.txt?type=block',
      body: { type: 'block', comment: 'keep me', groups: [0, 2], enabled: true },
    });
  });

  test('update and delete require type; all mutating actions require address', async () => {
    await assert.rejects(client.adlists('update', { address: 'a' }), /requires type/);
    await assert.rejects(client.adlists('delete', { address: 'a' }), /requires type/);
    await assert.rejects(client.adlists('add'), /requires address/);
    await assert.rejects(client.adlists('bogus', { address: 'a', type: 'block' }), /unknown adlist action/);
    assert.equal(seen.length, 0);
  });

  test('delete names the type and encodes the address', async () => {
    await client.adlists('delete', { address: 'https://x.example/l.txt', type: 'allow' });
    assert.deepEqual(seen.at(-1), {
      method: 'DELETE', url: '/api/lists/https%3A%2F%2Fx.example%2Fl.txt?type=allow', body: undefined,
    });
  });
});

describe('tool schemas', () => {
  const tool = (n: string) => toolDefs.find((t) => t.name === n)!;
  test('the new tools are registered', () => {
    for (const n of ['pihole_stats', 'pihole_blocking_status', 'pihole_adlist_management']) assert.ok(tool(n), n);
  });
  test('handlers reach the fake server through the registered instance', async () => {
    const s = tool('pihole_stats');
    await s.handler(s.schema.parse({ kind: 'top_clients', blocked: true, count: 2 }));
    assert.equal(seen.at(-1)!.url, '/api/stats/top_clients?blocked=true&count=2');
    await tool('pihole_blocking_status').handler({});
    assert.equal(seen.at(-1)!.url, '/api/dns/blocking');
  });
  test('pihole_stats rejects unknown kinds and negative counts', () => {
    const s = tool('pihole_stats').schema;
    assert.ok(s.safeParse({ kind: 'top_domains', count: 3 }).success);
    assert.ok(!s.safeParse({ kind: 'nope' }).success);
    assert.ok(!s.safeParse({ kind: 'top_domains', count: -1 }).success);
  });
  test('pihole_adlist_management only accepts known actions and types', () => {
    const s = tool('pihole_adlist_management').schema;
    assert.ok(s.safeParse({ action: 'list' }).success);
    assert.ok(!s.safeParse({ action: 'purge' }).success);
    assert.ok(!s.safeParse({ action: 'add', address: 'a', type: 'deny' }).success);
  });
});
