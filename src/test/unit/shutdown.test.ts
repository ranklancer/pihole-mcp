import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MIN_TOKEN_LENGTH } from '../../http-security.js';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js');
// Throwaway value for these tests only; not a real credential.
const TOKEN = 'unit-test-token-'.padEnd(MIN_TOKEN_LENGTH + 8, 'x');

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

describe('HTTP transport + Pi-hole client, end to end', () => {
  let pihole: http.Server;
  let piholeUrl = '';
  let logins = 0;
  let logoutDelayMs = 0;
  const logouts: string[] = [];
  const statsCalls: string[] = [];
  let child: ChildProcess;
  let port = 0;
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  before(async () => {
    pihole = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      req.resume();
      req.on('end', () => {
        if (req.url === '/api/auth' && req.method === 'POST') {
          const sid = `sid-${++logins}`;
          setTimeout(() => res.end(JSON.stringify({ session: { valid: true, sid, csrf: 'c' } })), 50);
        } else if (req.url === '/api/auth' && req.method === 'DELETE') {
          logouts.push(String(req.headers['x-ftl-sid']));
          setTimeout(() => { res.statusCode = 204; res.end(); }, logoutDelayMs);
        } else {
          statsCalls.push(String(req.headers['x-ftl-sid']));
          res.end(JSON.stringify({ queries: { total: 1 } }));
        }
      });
    });
    await new Promise<void>((r) => pihole.listen(0, '127.0.0.1', r));
    piholeUrl = `http://127.0.0.1:${(pihole.address() as AddressInfo).port}`;

    port = await freePort();
    child = spawn(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH,
        HOST: '127.0.0.1', PORT: String(port), MCP_AUTH_TOKEN: TOKEN,
        PIHOLE_INSTANCES: 'fake', FAKE_BASE_URL: piholeUrl, FAKE_PASSWORD: 'unit-test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exit = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout!.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', () => reject(new Error('server exited early')));
    });
  });

  after(async () => {
    child.kill('SIGKILL');
    pihole.closeAllConnections();
    await new Promise<void>((r) => pihole.close(() => r()));
  });

  const callTool = (token: string | undefined) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'pihole_stats_summary', arguments: {} } }),
  });

  test('the token check still guards /mcp and no login happens without it', async () => {
    const r = await callTool(undefined);
    assert.equal(r.status, 401);
    assert.equal(logins, 0);
  });

  test('5 concurrent authenticated tool calls cause 1 Pi-hole login', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => callTool(TOKEN)));
    for (const r of rs) {
      assert.equal(r.status, 200);
      assert.match(await r.text(), /total/);
    }
    assert.equal(logins, 1);
    assert.equal(statsCalls.length, 5);
  });

  test('SIGTERM closes the server, logs out of Pi-hole, then exits 0', async () => {
    logoutDelayMs = 600;
    let exited = false;
    void exit.then(() => { exited = true; });
    child.kill('SIGTERM');
    // The logout request arrives while its response is still pending: by then
    // the HTTP listener must already be closed and the process still alive.
    for (let i = 0; i < 100 && logouts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(logouts, ['sid-1']);
    assert.equal(exited, false, 'process must wait for the logout');
    await assert.rejects(callTool(TOKEN), 'listener must be closed before logout');
    const { code } = await Promise.race([
      exit,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('did not exit within 8s')), 8_000)),
    ]);
    assert.equal(code, 0);
    assert.deepEqual(logouts, ['sid-1']);
    // The listener is gone.
    await assert.rejects(callTool(TOKEN));
  });
});
