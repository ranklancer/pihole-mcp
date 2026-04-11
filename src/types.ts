/** Configuration for a single Pi-hole instance. */
export interface PiholeInstanceConfig {
  name: string;
  baseUrl: string;
  password: string;
  insecureTLS: boolean;
}

/** Authenticated session state. */
export interface PiholeSession {
  sid: string;
  csrf: string;
  expiresAt: number;
}

/** Options for querying the Pi-hole query log. */
export interface QueryOpts {
  limit?: number;
  from?: number;
  until?: number;
  client?: string;
  domain?: string;
  status?: string;
}

/** Options for group management operations. */
export interface GroupOpts {
  name?: string;
  enabled?: boolean;
  comment?: string;
}

// Regex metachars that NEVER appear in plain DNS labels.
// Note: '.' is intentionally excluded — every legitimate domain has dots.
// A real Pi-hole regex pattern always contains at least one of these.
export const REGEX_METACHARS = /[\\^$*+?()[\]{}|]/;

export function looksLikeRegex(domain: string): boolean {
  return REGEX_METACHARS.test(domain);
}
