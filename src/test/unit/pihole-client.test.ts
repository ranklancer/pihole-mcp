import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PiholeClient } from '../../pihole-client.js';

// A fake Pi-hole v6: counts logins/logouts, issues numbered session ids and
// can be told to answer 401 once, hang, or delay the login.
class FakePihole {
  logins = 0;
  logouts: string[] = [];
  apiCalls: string[] = [];          // sid used on each /api/stats call
  validSids = new Set<string>();
  loginDelayMs = 0;
  force401Once = false;
  hang = false;
  private server: http.Server;
  private sockets = new Set<import('node:net').Socket>();
  baseUrl = '';

  constructor() {
    this.server = http.createServer((req, res) => {
      const done = () => res.end();
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/auth' && req.method === 'POST') {
          const n = ++this.logins;
          setTimeout(() => {
            const sid = `sid-${n}`;
            this.validSids.add(sid);
            res.end(JSON.stringify({ session: { valid: true, sid, csrf: 'c' } }));
          }, this.loginDelayMs);
          return;
        }
        if (req.url === '/api/auth' && req.method === 'DELETE') {
          const sid = String(req.headers['x-ftl-sid']);
          this.logouts.push(sid);
          this.validSids.delete(sid);
          res.statusCode = 204; done(); return;
        }
        const sid = String(req.headers['x-ftl-sid']);
        this.apiCalls.push(sid);
        if (this.hang) return; // never answer
        if (this.force401Once) {
          this.force401Once = false;
          this.validSids.clear();
        }
        if (!this.validSids.has(sid)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { key: 'unauthorized', message: 'Unauthorized' } }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('PiholeClient hardening', () => {
  let fake: FakePihole;
  const mk = (extra: Partial<ConstructorParameters<typeof PiholeClient>[0]> = {}) =>
    new PiholeClient({ name: 'fake', baseUrl: fake.baseUrl, password: 'unit-test-only', insecureTLS: false, ...extra });

  beforeEach(async () => { fake = new FakePihole(); await fake.start(); });
  afterEach(async () => { await fake.stop(); });

  test('5 concurrent calls cause exactly 1 login (single-flight)', async () => {
    fake.loginDelayMs = 100;
    const c = mk();
    const results = await Promise.all(Array.from({ length: 5 }, () => c.call('GET', '/api/stats/summary')));
    assert.equal(results.length, 5);
    assert.equal(fake.logins, 1);
    assert.deepEqual(new Set(fake.apiCalls), new Set(['sid-1']));
  });

  test('a later call reuses the cached session', async () => {
    const c = mk();
    await c.call('GET', '/api/stats/summary');
    await c.call('GET', '/api/stats/summary');
    assert.equal(fake.logins, 1);
  });

  test('a failed login is not cached: the next call logs in again', async () => {
    const c = mk({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(c.ensureSession());
    await assert.rejects(c.ensureSession());
  });

  test('401 then success re-logs in exactly once and retries', async () => {
    const c = mk();
    await c.call('GET', '/api/stats/summary');
    assert.equal(fake.logins, 1);
    fake.force401Once = true;
    const r = await c.call('GET', '/api/stats/summary');
    assert.deepEqual(r, { ok: true });
    assert.equal(fake.logins, 2);
    assert.deepEqual(fake.apiCalls.slice(-2), ['sid-1', 'sid-2']);
  });

  test('concurrent 401s share one re-login', async () => {
    const c = mk();
    await c.call('GET', '/api/stats/summary');
    fake.validSids.clear();                       // server forgot every session
    await Promise.all(Array.from({ length: 4 }, () => c.call('GET', '/api/stats/summary')));
    assert.equal(fake.logins, 2);
  });

  test('a persistent 401 retries once, then surfaces the error', async () => {
    const c = mk();
    await c.call('GET', '/api/stats/summary');
    // Every new session is immediately invalid.
    Object.defineProperty(fake, 'validSids', { value: { has: () => false, add() {}, delete() {}, clear() {} } });
    await assert.rejects(c.call('GET', '/api/stats/summary'), /Unauthorized/);
    assert.equal(fake.logins, 2, 'one original login plus exactly one re-login');
  });

  test('a hung request times out instead of waiting for the default', async () => {
    const c = mk({ requestTimeoutMs: 300 });
    await c.ensureSession();
    fake.hang = true;
    const t0 = Date.now();
    await assert.rejects(c.call('GET', '/api/stats/summary'));
    assert.ok(Date.now() - t0 < 3_000, 'should fail well inside 3s');
  });

  test('an unreachable host fails on the connect timeout path, not forever', async () => {
    // RFC 5737 TEST-NET address: connect attempts are dropped, so only the timeout ends them.
    const c = mk({ baseUrl: 'http://192.0.2.1:9' });
    const t0 = Date.now();
    await assert.rejects(c.ensureSession());
    assert.ok(Date.now() - t0 < 8_000);
  });

  test('logout sends DELETE with the sid, clears the session, and is a no-op when logged out', async () => {
    const c = mk();
    await c.logout();
    assert.deepEqual(fake.logouts, []);
    await c.ensureSession();
    await c.logout();
    assert.deepEqual(fake.logouts, ['sid-1']);
    await c.logout();
    assert.deepEqual(fake.logouts, ['sid-1']);
  });

  test('logout waits for a login that is still in flight, so no seat leaks', async () => {
    fake.loginDelayMs = 150;
    const c = mk();
    const p = c.ensureSession();
    await new Promise((r) => setTimeout(r, 30));
    await c.logout();
    await p;
    assert.deepEqual(fake.logouts, ['sid-1']);
  });

  test('logout never throws and is bounded when Pi-hole is gone', async () => {
    const c = mk();
    await c.ensureSession();
    await fake.stop();
    const t0 = Date.now();
    await c.logout();
    assert.ok(Date.now() - t0 < 3_000);
    fake = new FakePihole(); await fake.start(); // for afterEach
  });
});
