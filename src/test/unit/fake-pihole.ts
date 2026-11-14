import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Send this raw string instead of JSON-encoding `body`. */
  raw?: string;
}

export type Handler = (req: Recorded) => Reply | undefined;

/**
 * Minimal local stand-in for the Pi-hole v6 API. It answers POST /api/auth
 * itself (configurable password) and delegates everything else to `handler`.
 */
export class FakePihole {
  readonly requests: Recorded[] = [];
  authCount = 0;
  handler: Handler = () => undefined;
  password = 'secret';
  private server = http.createServer((req, res) => this.onRequest(req, res));

  async start(): Promise<string> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(r => this.server.close(() => r()));
  }

  reset(): void {
    this.requests.length = 0;
    this.authCount = 0;
    this.handler = () => undefined;
  }

  /** Requests other than the auth handshake. */
  get apiCalls(): Recorded[] {
    return this.requests.filter(r => r.path !== '/api/auth');
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      const rec: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
      this.requests.push(rec);

      let reply: Reply | undefined;
      if (rec.path === '/api/auth' && rec.method === 'POST') {
        this.authCount++;
        reply = body?.password === this.password
          ? { body: { session: { valid: true, sid: `sid-${this.authCount}`, csrf: 'csrf', validity: 300 } } }
          : { status: 401, body: { session: { valid: false, message: 'password incorrect' } } };
      } else if (rec.path === '/api/auth' && rec.method === 'DELETE') {
        reply = { status: 204, raw: '' };
      } else {
        reply = this.handler(rec);
      }
      const r = reply ?? { body: {} };
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
    });
  }
}
