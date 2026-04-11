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
