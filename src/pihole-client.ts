import { request, Agent, Dispatcher } from 'undici';
import { looksLikeRegex } from './types.js';
import type { PiholeInstanceConfig, PiholeSession, QueryOpts, GroupOpts } from './types.js';

const SESSION_TTL_MS = 4 * 60 * 1000;

export class PiholeClient {
  private session: PiholeSession | null = null;
  private dispatcher?: Agent;

  constructor(private cfg: PiholeInstanceConfig) {
    if (cfg.insecureTLS) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  /** Authenticate with the Pi-hole v6 API and cache the session. */
  async ensureSession(): Promise<PiholeSession> {
    const now = Date.now();
    if (this.session && this.session.expiresAt > now + 5_000) return this.session;

    const res = await request(`${this.cfg.baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.cfg.password }),
      dispatcher: this.dispatcher,
    });
    const body = (await res.body.json()) as any;

    if (!body?.session?.valid || !body.session.sid) {
      throw new Error(`[${this.cfg.name}] auth failed: ${body?.session?.message ?? 'unknown'}`);
    }
    this.session = {
      sid: body.session.sid,
      csrf: body.session.csrf,
      expiresAt: now + SESSION_TTL_MS,
    };
    return this.session;
  }

  /** Delete the current session. */
  async logout(): Promise<void> {
    if (!this.session) return;
    try {
      await request(`${this.cfg.baseUrl}/api/auth`, {
        method: 'DELETE',
        headers: { 'X-FTL-SID': this.session.sid },
        dispatcher: this.dispatcher,
      });
    } catch { /* swallow */ }
    this.session = null;
  }

  /** Generic authenticated API call. */
  async call(method: Dispatcher.HttpMethod, path: string, payload?: unknown): Promise<any> {
    const sess = await this.ensureSession();
    const url = `${this.cfg.baseUrl}${path}`;
    const headers: Record<string, string> = { 'X-FTL-SID': sess.sid };
    let body: string | undefined;

    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    const res = await request(url, { method, headers, body, dispatcher: this.dispatcher });
    const text = await res.body.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : {}; }
    catch { parsed = { raw: text }; }

    if (res.statusCode >= 400 || parsed?.error) {
      const msg = parsed?.error?.message ?? `HTTP ${res.statusCode}`;
      throw new Error(`[${this.cfg.name}] ${method} ${path} failed: ${msg}`);
    }
    return parsed;
  }

  // ── Convenience wrappers ──────────────────────────────────────────

  async statsSummary() { return this.call('GET', '/api/stats/summary'); }
  async version()      { return this.call('GET', '/api/info/version'); }

  async queries(opts: QueryOpts = {}) {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined)  qs.set('length', String(opts.limit));
    if (opts.from !== undefined)   qs.set('from',   String(opts.from));
    if (opts.until !== undefined)  qs.set('until',  String(opts.until));
    if (opts.client)               qs.set('client', opts.client);
    if (opts.domain)               qs.set('domain', opts.domain);
    if (opts.status)               qs.set('status', opts.status);
    const q = qs.toString();
    return this.call('GET', `/api/queries${q ? '?' + q : ''}`);
  }

  async listAllowExact() { return this.call('GET', '/api/domains/allow/exact'); }
  async listAllowRegex() { return this.call('GET', '/api/domains/allow/regex'); }
  async listDenyExact()  { return this.call('GET', '/api/domains/deny/exact');  }
  async listDenyRegex()  { return this.call('GET', '/api/domains/deny/regex');  }

  async addDomain(listType: 'allow' | 'deny', domain: string, comment?: string) {
    const kind = looksLikeRegex(domain) ? 'regex' : 'exact';
    const result = await this.call('POST', `/api/domains/${listType}/${kind}`, {
      domain, comment: comment ?? null, groups: [0], enabled: true,
    });
    return { kind, result };
  }

  async reloadGravity() { return this.call('POST', '/api/action/gravity'); }

  // -- Blocking control ----------------------------------------------

  /** Enable/disable DNS blocking; optional timer (seconds) auto-reverts. */
  async setBlocking(enabled: boolean, timer?: number) {
    return this.call('POST', '/api/dns/blocking', {
      blocking: enabled,
      timer: timer ?? null,
    });
  }

  // -- Domain update / delete (completes allow/deny CRUD) ------------

  async updateDomain(
    listType: 'allow' | 'deny',
    kind: 'exact' | 'regex',
    domain: string,
    opts: { comment?: string | null; groups?: number[]; enabled?: boolean } = {},
  ) {
    const path = `/api/domains/${listType}/${kind}/${encodeURIComponent(domain)}`;
    // Pi-hole's domain PUT is a full replace, not a merge. Read the current
    // entry first and only override the fields the caller supplied, so an
    // update to (say) the comment can't silently reset groups or re-enable
    // a disabled entry. Falls back to create-style defaults if the entry
    // can't be read.
    let current: any = {};
    try {
      const existing = await this.call('GET', path);
      current = existing?.domains?.[0] ?? existing?.domain ?? {};
    } catch { /* entry unreadable — fall through to defaults below */ }
    return this.call('PUT', path, {
      comment: opts.comment !== undefined ? opts.comment : (current.comment ?? null),
      groups:  opts.groups  !== undefined ? opts.groups  : (current.groups ?? [0]),
      enabled: opts.enabled !== undefined ? opts.enabled : (current.enabled ?? true),
    });
  }

  async deleteDomain(listType: 'allow' | 'deny', kind: 'exact' | 'regex', domain: string) {
    const path = `/api/domains/${listType}/${kind}/${encodeURIComponent(domain)}`;
    return this.call('DELETE', path);
  }

  // -- Local DNS: A records (config.dns.hosts) -----------------------

  async listLocalDNS() {
    const res = await this.call('GET', '/api/config/dns/hosts');
    const hosts: string[] = res?.config?.dns?.hosts ?? res?.hosts ?? [];
    return {
      records: hosts.map((entry: string) => {
        const [ip, ...domains] = entry.trim().split(/\s+/);
        return { ip, domains, raw: entry };
      }),
    };
  }

  async addLocalDNS(ip: string, domain: string) {
    const value = `${ip} ${domain}`;
    return this.call('PUT', `/api/config/dns/hosts/${encodeURIComponent(value)}`);
  }

  async deleteLocalDNS(ip: string, domain: string) {
    const value = `${ip} ${domain}`;
    return this.call('DELETE', `/api/config/dns/hosts/${encodeURIComponent(value)}`);
  }

  // -- Local DNS: CNAME records (config.dns.cnameRecords) ------------

  async listCnames() {
    const res = await this.call('GET', '/api/config/dns/cnameRecords');
    const rows: string[] = res?.config?.dns?.cnameRecords ?? res?.cnameRecords ?? [];
    return {
      records: rows.map((entry: string) => {
        const [domain, target, ttl] = entry.split(',');
        return { domain, target, ttl: ttl && Number.isFinite(Number(ttl)) ? Number(ttl) : undefined, raw: entry };
      }),
    };
  }

  async addCname(domain: string, target: string, ttl?: number) {
    const value = ttl !== undefined ? `${domain},${target},${ttl}` : `${domain},${target}`;
    return this.call('PUT', `/api/config/dns/cnameRecords/${encodeURIComponent(value)}`);
  }

  async deleteCname(domain: string, target: string, ttl?: number) {
    const value = ttl !== undefined ? `${domain},${target},${ttl}` : `${domain},${target}`;
    return this.call('DELETE', `/api/config/dns/cnameRecords/${encodeURIComponent(value)}`);
  }

  async groups(action: string, opts: GroupOpts = {}) {
    if (action === 'list') return this.call('GET', '/api/groups');
    if (action === 'create') {
      return this.call('POST', '/api/groups', {
        name: opts.name, enabled: opts.enabled ?? true, comment: opts.comment ?? null,
      });
    }
    if (action === 'update') {
      if (!opts.name) throw new Error('group update requires name');
      return this.call('PUT', `/api/groups/${encodeURIComponent(opts.name)}`, {
        enabled: opts.enabled, comment: opts.comment,
      });
    }
    if (action === 'delete') {
      if (!opts.name) throw new Error('group delete requires name');
      return this.call('DELETE', `/api/groups/${encodeURIComponent(opts.name)}`);
    }
    throw new Error(`unknown group action: ${action}`);
  }

  /** Detect deny-exact entries that look like regex (likely miscategorized). */
  async checkRegexTypes() {
    const exact = await this.listDenyExact();
    const suspect = (exact.domains ?? []).filter((d: any) => looksLikeRegex(d.domain));
    return { instance: this.cfg.name, suspect };
  }
}
