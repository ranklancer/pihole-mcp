import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp, isLoopbackHost, loadHttpSecurityConfig, MIN_TOKEN_LENGTH } from '../../http-security.js';

// Throwaway value for these tests only; not a real credential.
const TOKEN = 'unit-test-token-'.padEnd(MIN_TOKEN_LENGTH + 8, 'x');

describe('loadHttpSecurityConfig', () => {
  test('defaults to a loopback bind with localhost Host allowlist and no auth', () => {
    const cfg = loadHttpSecurityConfig({});
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 3000);
    assert.deepEqual(cfg.allowedHosts, ['localhost', '127.0.0.1', '[::1]']);
    assert.deepEqual(cfg.allowedOrigins, []);
    assert.equal(cfg.authToken, undefined);
  });

  test('refuses a non-loopback bind without the opt-in', () => {
    assert.throws(() => loadHttpSecurityConfig({ HOST: '0.0.0.0' }), /MCP_ALLOW_NON_LOOPBACK/);
    assert.throws(() => loadHttpSecurityConfig({ HOST: '192.0.2.10' }), /MCP_ALLOW_NON_LOOPBACK/);
    assert.throws(() => loadHttpSecurityConfig({ HOST: '::' }), /MCP_ALLOW_NON_LOOPBACK/);
  });

  test('accepts a non-loopback bind with the opt-in', () => {
    const cfg = loadHttpSecurityConfig({ HOST: '0.0.0.0', MCP_ALLOW_NON_LOOPBACK: 'true' });
    assert.equal(cfg.host, '0.0.0.0');
  });

  test('loopback detection', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.ok(isLoopbackHost(h), h);
    for (const h of ['0.0.0.0', '::', '192.0.2.1', 'example.com', '127.0.0.1.example.com']) assert.ok(!isLoopbackHost(h), h);
  });

  test('normalises and validates allowed origins', () => {
    const cfg = loadHttpSecurityConfig({ MCP_ALLOWED_ORIGINS: 'HTTP://LocalHost:6274/, https://mcp.example.com:443' });
    assert.deepEqual(cfg.allowedOrigins, ['http://localhost:6274', 'https://mcp.example.com']);
    assert.throws(() => loadHttpSecurityConfig({ MCP_ALLOWED_ORIGINS: 'not a url' }), /valid origin/);
    assert.throws(() => loadHttpSecurityConfig({ MCP_ALLOWED_ORIGINS: 'https://a.example/path' }), /plain origin/);
  });

  test('rejects an empty MCP_ALLOWED_HOSTS', () => {
    assert.throws(() => loadHttpSecurityConfig({ MCP_ALLOWED_HOSTS: ' , ' }), /empty/);
  });

  test('reads the token from env or from a file, never both, with a minimum length', () => {
    assert.equal(loadHttpSecurityConfig({ MCP_AUTH_TOKEN: TOKEN }).authToken, TOKEN);
    assert.throws(() => loadHttpSecurityConfig({ MCP_AUTH_TOKEN: 'short' }), /too short/);

    const dir = mkdtempSync(join(tmpdir(), 'pihole-mcp-test-'));
    try {
      const file = join(dir, 'token');
      writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
      assert.equal(loadHttpSecurityConfig({ MCP_AUTH_TOKEN_FILE: file }).authToken, TOKEN);
      assert.throws(() => loadHttpSecurityConfig({ MCP_AUTH_TOKEN_FILE: file, MCP_AUTH_TOKEN: TOKEN }), /only one/);
      // Fail closed when the configured file is missing or empty.
      assert.throws(() => loadHttpSecurityConfig({ MCP_AUTH_TOKEN_FILE: join(dir, 'missing') }), /ENOENT/);
      writeFileSync(join(dir, 'empty'), '\n');
      assert.throws(() => loadHttpSecurityConfig({ MCP_AUTH_TOKEN_FILE: join(dir, 'empty') }), /empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('error messages never contain the token', () => {
    const short = 'tooshort-secret-value';
    try {
      loadHttpSecurityConfig({ MCP_AUTH_TOKEN: short });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(!String((err as Error).message).includes(short));
    }
  });
});

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(port: number, path: string, headers: Record<string, string>, method = 'POST'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    else req.end();
  });
}

function startApp(env: NodeJS.ProcessEnv): Promise<{ server: http.Server; port: number }> {
  const cfg = loadHttpSecurityConfig({ PORT: '0', ...env });
  // Stub MCP handler: proves the request got past every check.
  const app = createHttpApp(cfg, async (_req, res) => { res.status(200).json({ reached: true }); }, '0.0.0-test');
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('HTTP app without a token', () => {
  let server: http.Server;
  let port: number;
  before(async () => ({ server, port } = await startApp({ MCP_ALLOWED_ORIGINS: 'http://localhost:6274' })));
  after(() => server.close());

  test('a loopback request with no Origin reaches /mcp', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, host: `127.0.0.1:${port}` });
    assert.equal(r.status, 200);
    assert.match(r.body, /reached/);
  });

  test('a foreign Origin gets 403', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, host: `localhost:${port}`, origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    assert.match(r.body, /Origin/);
  });

  test('an allowlisted Origin passes', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, host: `localhost:${port}`, origin: 'http://localhost:6274' });
    assert.equal(r.status, 200);
  });

  test('a rebinding-style Host header gets 403', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, host: `attacker.example:${port}` });
    assert.equal(r.status, 403);
    assert.match(r.body, /Host/);
  });

  test('/health is open but still Host- and Origin-checked', async () => {
    assert.equal((await request(port, '/health', { host: `127.0.0.1:${port}` }, 'GET')).status, 200);
    assert.equal((await request(port, '/health', { host: 'attacker.example' }, 'GET')).status, 403);
    assert.equal((await request(port, '/health', { host: '127.0.0.1', origin: 'http://evil.example' }, 'GET')).status, 403);
  });

  test('malformed JSON gets a JSON-RPC parse error, not a stack trace', async () => {
    const r = await new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { ...JSON_HEADERS, host: '127.0.0.1' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end('{not json');
    });
    assert.equal(r.status, 400);
    assert.match(r.body, /-32700/);
    assert.doesNotMatch(r.body, /at |node_modules/);
  });
});

describe('HTTP app body handling', () => {
  let server: http.Server;
  let port: number;
  before(async () => ({ server, port } = await startApp({})));
  after(() => server.close());

  test('a compressed body is refused with 415 rather than inflated', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, host: '127.0.0.1', 'content-encoding': 'gzip' });
    assert.equal(r.status, 415);
    assert.match(r.body, /jsonrpc/);
  });
});

describe('HTTP app with a token', () => {
  let server: http.Server;
  let port: number;
  before(async () => ({ server, port } = await startApp({ MCP_AUTH_TOKEN: TOKEN })));
  after(() => server.close());

  const host = () => ({ host: `127.0.0.1:${port}` });

  test('a missing token gets 401 with a Bearer challenge', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, ...host() });
    assert.equal(r.status, 401);
    assert.match(String(r.headers['www-authenticate']), /^Bearer/);
  });

  test('a wrong token gets 401 and is not echoed', async () => {
    const wrong = `${TOKEN}-wrong`;
    const r = await request(port, '/mcp', { ...JSON_HEADERS, ...host(), authorization: `Bearer ${wrong}` });
    assert.equal(r.status, 401);
    assert.ok(!r.body.includes(wrong));
  });

  test('a non-Bearer scheme gets 401', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, ...host(), authorization: `Basic ${TOKEN}` });
    assert.equal(r.status, 401);
  });

  test('the correct token passes', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, ...host(), authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
  });

  test('Origin is checked before auth', async () => {
    const r = await request(port, '/mcp', { ...JSON_HEADERS, ...host(), origin: 'http://evil.example', authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 403);
  });

  test('/health needs no token', async () => {
    assert.equal((await request(port, '/health', host(), 'GET')).status, 200);
  });
});
