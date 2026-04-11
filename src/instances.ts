import { readFileSync, existsSync } from 'node:fs';
import { PiholeClient } from './pihole-client.js';
import type { PiholeInstanceConfig } from './types.js';

/**
 * Dynamic multi-instance loader.
 *
 * Instances are configured via environment variables following these patterns:
 *
 *   PIHOLE_INSTANCES        — comma-separated list of instance names (e.g. "primary,secondary")
 *                              Defaults to "pihole" if not set.
 *
 * For each instance <NAME> (uppercased):
 *   <NAME>_BASE_URL         — Pi-hole base URL  (required, e.g. "http://pihole.example.com")
 *   <NAME>_PASSWORD          — Pi-hole API password (or read from Docker secret)
 *   <NAME>_INSECURE_TLS     — set to "true" to skip TLS verification (default: "false")
 *
 * Docker secrets fallback: /run/secrets/<name>_password  (lowercase)
 */

function loadPassword(envVar: string, secretPath: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv.trim();
  if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim();
  throw new Error(`No password found for ${envVar} (checked env and ${secretPath})`);
}

function parseInstances(): Map<string, PiholeInstanceConfig> {
  const raw = process.env.PIHOLE_INSTANCES ?? 'pihole';
  const names = raw.split(',').map(n => n.trim()).filter(Boolean);

  if (names.length === 0) {
    throw new Error('PIHOLE_INSTANCES is empty — define at least one instance name');
  }

  const configs = new Map<string, PiholeInstanceConfig>();

  for (const name of names) {
    const envPrefix = name.toUpperCase();
    const baseUrl = process.env[`${envPrefix}_BASE_URL`];
    if (!baseUrl) {
      throw new Error(
        `Missing ${envPrefix}_BASE_URL for instance "${name}". ` +
        `Set PIHOLE_INSTANCES and provide <NAME>_BASE_URL for each.`
      );
    }

    configs.set(name, {
      name,
      baseUrl,
      password: loadPassword(
        `${envPrefix}_PASSWORD`,
        `/run/secrets/${name.toLowerCase()}_password`
      ),
      insecureTLS: (process.env[`${envPrefix}_INSECURE_TLS`] ?? 'false') === 'true',
    });
  }

  return configs;
}

const instanceConfigs = parseInstances();
const clients = new Map<string, PiholeClient>();

/** Get a PiholeClient by instance name. Defaults to the first configured instance. */
export function getClient(name?: string): PiholeClient {
  const key = name ?? allInstanceNames()[0];
  if (!instanceConfigs.has(key)) {
    throw new Error(
      `Unknown instance "${key}". Available: ${allInstanceNames().join(', ')}`
    );
  }
  if (!clients.has(key)) {
    clients.set(key, new PiholeClient(instanceConfigs.get(key)!));
  }
  return clients.get(key)!;
}

/** Return all configured instance names. */
export function allInstanceNames(): string[] {
  return [...instanceConfigs.keys()];
}
