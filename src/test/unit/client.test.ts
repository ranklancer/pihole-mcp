import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PiholeClient } from '../../pihole-client.js';
import { FakePihole } from './fake-pihole.js';

const fake = new FakePihole();
let client: PiholeClient;
let baseUrl: string;

before(async () => { baseUrl = await fake.start(); });
after(async () => { await fake.stop(); });
beforeEach(() => {
  fake.reset();
  client = new PiholeClient({ name: 'test', baseUrl, password: 'secret', insecureTLS: false });
});

describe('auth', () => {
  test('logs in with the configured password and sends the sid on API calls', async () => {
    fake.handler = () => ({ body: { queries: 1 } });
    await client.statsSummary();
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].path, '/api/auth');
    assert.deepEqual(fake.requests[0].body, { password: 'secret' });
    assert.equal(fake.apiCalls[0].path, '/api/stats/summary');
    assert.equal(fake.apiCalls[0].headers['x-ftl-sid'], 'sid-1');
  });

  test('caches the session across calls', async () => {
    await client.statsSummary();
    await client.version();
    assert.equal(fake.authCount, 1);
    assert.equal(fake.apiCalls.length, 2);
  });

  test('rejects with the instance name and server message on a bad password', async () => {
    const bad = new PiholeClient({ name: 'lab', baseUrl, password: 'wrong', insecureTLS: false });
    await assert.rejects(bad.statsSummary(), /\[lab\] auth failed: password incorrect/);
    assert.equal(fake.apiCalls.length, 0);
  });

  test('logout sends DELETE /api/auth and forces a fresh login', async () => {
    await client.statsSummary();
    await client.logout();
    assert.deepEqual(fake.requests.slice(-1).map(r => [r.method, r.path]), [['DELETE', '/api/auth']]);
    await client.statsSummary();
    assert.equal(fake.authCount, 2);
  });
});

describe('error mapping', () => {
  test('HTTP error with an API error body surfaces its message', async () => {
    fake.handler = () => ({ status: 400, body: { error: { key: 'bad_request', message: 'Invalid domain' } } });
    await assert.rejects(client.deleteDomain('deny', 'exact', 'x'), /\[test\] DELETE \/api\/domains\/deny\/exact\/x failed: Invalid domain/);
  });

  test('HTTP error without a body falls back to the status code', async () => {
    fake.handler = () => ({ status: 500, raw: '' });
    await assert.rejects(client.statsSummary(), /failed: HTTP 500/);
  });

  test('a 200 response carrying an error object is still an error', async () => {
    fake.handler = () => ({ body: { error: { message: 'nope' } } });
    await assert.rejects(client.statsSummary(), /failed: nope/);
  });

  test('non-JSON success bodies are returned as { raw }', async () => {
    fake.handler = () => ({ raw: 'plain text' });
    assert.deepEqual(await client.statsSummary(), { raw: 'plain text' });
  });

  test('empty success bodies resolve to {}', async () => {
    fake.handler = () => ({ status: 204, raw: '' });
    assert.deepEqual(await client.reloadGravity(), {});
  });
});

describe('query log', () => {
  test('maps options onto Pi-hole query parameters', async () => {
    await client.queries({ limit: 5, from: 10, until: 20, client: '192.168.1.*', clientName: 'tv', domain: 'a.com', status: 'GRAVITY' });
    const url = new URL(fake.apiCalls[0].path, 'http://x');
    assert.equal(url.pathname, '/api/queries');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      length: '5', from: '10', until: '20', client_ip: '192.168.1.*', client_name: 'tv', domain: 'a.com', status: 'GRAVITY',
    });
  });

  test('no options means no query string', async () => {
    await client.queries();
    assert.equal(fake.apiCalls[0].path, '/api/queries');
  });
});

describe('domains', () => {
  test('addDomain routes exact names to /exact and patterns to /regex', async () => {
    const exact = await client.addDomain('deny', 'ads.example.com', 'c');
    const regex = await client.addDomain('allow', '^ads\\d+\\.example\\.com$');
    assert.equal(exact.kind, 'exact');
    assert.equal(regex.kind, 'regex');
    assert.deepEqual(fake.apiCalls.map(r => [r.method, r.path]), [
      ['POST', '/api/domains/deny/exact'],
      ['POST', '/api/domains/allow/regex'],
    ]);
    assert.deepEqual(fake.apiCalls[0].body, { domain: 'ads.example.com', comment: 'c', groups: [0], enabled: true });
    assert.equal(fake.apiCalls[1].body.comment, null);
  });

  test('updateDomain reads the current entry and keeps fields the caller omitted', async () => {
    fake.handler = r => r.method === 'GET'
      ? { body: { domains: [{ domain: 'a.com', comment: 'old', groups: [0, 3], enabled: false }] } }
      : undefined;
    await client.updateDomain('deny', 'exact', 'a.com', { comment: 'new' });
    const [get, put] = fake.apiCalls;
    assert.equal(get.method, 'GET');
    assert.equal(put.method, 'PUT');
    assert.equal(put.path, '/api/domains/deny/exact/a.com');
    assert.deepEqual(put.body, { comment: 'new', groups: [0, 3], enabled: false });
  });

  test('updateDomain lets explicit values override the stored ones', async () => {
    fake.handler = r => r.method === 'GET'
      ? { body: { domains: [{ comment: 'old', groups: [0, 3], enabled: false }] } }
      : undefined;
    await client.updateDomain('allow', 'regex', '^x$', { groups: [1], enabled: true, comment: null });
    assert.deepEqual(fake.apiCalls[1].body, { comment: null, groups: [1], enabled: true });
    assert.equal(fake.apiCalls[1].path, `/api/domains/allow/regex/${encodeURIComponent('^x$')}`);
  });

  test('updateDomain falls back to create-style defaults when the entry is unreadable', async () => {
    fake.handler = r => r.method === 'GET' ? { status: 404, body: { error: { message: 'not found' } } } : undefined;
    await client.updateDomain('deny', 'exact', 'a.com');
    assert.deepEqual(fake.apiCalls[1].body, { comment: null, groups: [0], enabled: true });
  });

  test('deleteDomain URL-encodes the domain', async () => {
    await client.deleteDomain('deny', 'regex', '(^|\\.)a\\.com$');
    assert.equal(fake.apiCalls[0].method, 'DELETE');
    assert.equal(fake.apiCalls[0].path, `/api/domains/deny/regex/${encodeURIComponent('(^|\\.)a\\.com$')}`);
  });

  test('checkRegexTypes flags only deny-exact entries that look like regex', async () => {
    fake.handler = () => ({ body: { domains: [{ domain: 'ok.example.com' }, { domain: '.*\\.bad\\.com$' }] } });
    const res = await client.checkRegexTypes();
    assert.equal(res.instance, 'test');
    assert.deepEqual(res.suspect.map((d: any) => d.domain), ['.*\\.bad\\.com$']);
    assert.equal(fake.apiCalls[0].path, '/api/domains/deny/exact');
  });
});

describe('blocking', () => {
  test('setBlocking posts the flag and an optional timer', async () => {
    await client.setBlocking(false, 300);
    await client.setBlocking(true);
    assert.deepEqual(fake.apiCalls.map(r => r.body), [
      { blocking: false, timer: 300 },
      { blocking: true, timer: null },
    ]);
    assert.equal(fake.apiCalls[0].path, '/api/dns/blocking');
  });
});

describe('local DNS and CNAME', () => {
  test('listLocalDNS splits entries into ip + domains', async () => {
    fake.handler = () => ({ body: { config: { dns: { hosts: ['192.0.2.1 a.lan b.lan', '192.0.2.2 c.lan'] } } } });
    const { records } = await client.listLocalDNS();
    assert.deepEqual(records.map(r => [r.ip, r.domains]), [['192.0.2.1', ['a.lan', 'b.lan']], ['192.0.2.2', ['c.lan']]]);
  });

  test('addLocalDNS / deleteLocalDNS use PUT / DELETE on the encoded "ip domain" value', async () => {
    await client.addLocalDNS('192.0.2.1', 'a.lan');
    await client.deleteLocalDNS('192.0.2.1', 'a.lan');
    const path = `/api/config/dns/hosts/${encodeURIComponent('192.0.2.1 a.lan')}`;
    assert.deepEqual(fake.apiCalls.map(r => [r.method, r.path]), [['PUT', path], ['DELETE', path]]);
  });

  test('listCnames parses domain, target and optional ttl', async () => {
    fake.handler = () => ({ body: { config: { dns: { cnameRecords: ['www.lan,host.lan,60', 'api.lan,host.lan'] } } } });
    const { records } = await client.listCnames();
    assert.deepEqual(records.map(r => [r.domain, r.target, r.ttl]), [['www.lan', 'host.lan', 60], ['api.lan', 'host.lan', undefined]]);
  });

  test('addCname / deleteCname include the ttl only when given', async () => {
    await client.addCname('www.lan', 'host.lan', 60);
    await client.addCname('api.lan', 'host.lan');
    await client.deleteCname('www.lan', 'host.lan', 60);
    assert.deepEqual(fake.apiCalls.map(r => [r.method, r.path]), [
      ['PUT', `/api/config/dns/cnameRecords/${encodeURIComponent('www.lan,host.lan,60')}`],
      ['PUT', `/api/config/dns/cnameRecords/${encodeURIComponent('api.lan,host.lan')}`],
      ['DELETE', `/api/config/dns/cnameRecords/${encodeURIComponent('www.lan,host.lan,60')}`],
    ]);
  });
});

describe('groups and clients', () => {
  test('groups create defaults enabled and comment', async () => {
    await client.groups('create', { name: 'kids' });
    assert.deepEqual(fake.apiCalls[0].body, { name: 'kids', enabled: true, comment: null });
  });

  test('groups update/delete require a name; unknown actions are rejected', async () => {
    await assert.rejects(client.groups('update', {}), /requires name/);
    await assert.rejects(client.groups('delete', {}), /requires name/);
    await assert.rejects(client.groups('bogus', {}), /unknown group action/);
    assert.equal(fake.requests.length, 0);
  });

  test('clients add defaults groups to [0]', async () => {
    await client.clients('add', { client: '192.0.2.5' });
    assert.deepEqual(fake.apiCalls[0].body, { client: '192.0.2.5', comment: null, groups: [0] });
  });

  test('clients update is read-modify-write', async () => {
    fake.handler = r => r.method === 'GET' ? { body: { clients: [{ comment: 'tv', groups: [2] }] } } : undefined;
    await client.clients('update', { client: '192.0.2.5', comment: 'living room' });
    assert.deepEqual(fake.apiCalls[1].body, { comment: 'living room', groups: [2] });
  });

  test('clients update on a missing client fails without writing', async () => {
    fake.handler = r => r.method === 'GET' ? { body: { clients: [] } } : undefined;
    await assert.rejects(client.clients('update', { client: 'nope' }), /client not found: nope/);
    assert.equal(fake.apiCalls.filter(r => r.method === 'PUT').length, 0);
  });

  test('clients actions other than list need a client', async () => {
    await assert.rejects(client.clients('delete', {}), /requires client/);
  });
});
