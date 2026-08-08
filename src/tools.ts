import { z } from 'zod';
import { getClient, allInstanceNames } from './instances.js';

/**
 * Build an instance selector enum from the configured instance names.
 * Falls back to a free-form string if only one instance is configured.
 */
function instanceSchema() {
  const names = allInstanceNames();
  if (names.length >= 2) {
    return z.enum(names as [string, ...string[]])
      .optional()
      .default(names[0])
      .describe(`Which Pi-hole instance to target. Available: ${names.join(', ')}. Defaults to ${names[0]}.`);
  }
  return z.string()
    .optional()
    .default(names[0])
    .describe(`Pi-hole instance name. Defaults to ${names[0]}.`);
}

const Instance = instanceSchema();

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  handler: (args: any) => Promise<any>;
}

export const toolDefs: ToolDef[] = [
  {
    name: 'pihole_query_log',
    description: 'Fetch query log entries from Pi-hole v6 /api/queries with optional filters.',
    schema: z.object({
      instance: Instance,
      limit:  z.number().int().positive().max(10000).optional(),
      from:   z.number().int().optional(),
      until:  z.number().int().optional(),
      client: z.string().optional(),
      domain: z.string().optional(),
      status: z.string().optional(),
    }),
    handler: async (args) => getClient(args.instance)
      .queries({ limit: args.limit, from: args.from, until: args.until,
                 client: args.client, domain: args.domain, status: args.status }),
  },
  {
    name: 'pihole_allow_domain',
    description: 'Add a domain to the allowlist. Auto-routes exact vs regex via metachar detection.',
    schema: z.object({ instance: Instance, domain: z.string().min(1), comment: z.string().optional() }),
    handler: async (args) => getClient(args.instance).addDomain('allow', args.domain, args.comment),
  },
  {
    name: 'pihole_deny_domain',
    description: 'Add a domain to the denylist. Auto-routes exact vs regex via metachar detection.',
    schema: z.object({ instance: Instance, domain: z.string().min(1), comment: z.string().optional() }),
    handler: async (args) => getClient(args.instance).addDomain('deny', args.domain, args.comment),
  },
  {
    name: 'pihole_list_allowlist',
    description: 'Returns merged allowlist (exact + regex).',
    schema: z.object({ instance: Instance }),
    handler: async (args) => {
      const c = getClient(args.instance);
      const [ex, rx] = await Promise.all([c.listAllowExact(), c.listAllowRegex()]);
      return { domains: [...(ex.domains ?? []), ...(rx.domains ?? [])] };
    },
  },
  {
    name: 'pihole_list_denylist',
    description: 'Returns merged denylist (exact + regex).',
    schema: z.object({ instance: Instance }),
    handler: async (args) => {
      const c = getClient(args.instance);
      const [ex, rx] = await Promise.all([c.listDenyExact(), c.listDenyRegex()]);
      return { domains: [...(ex.domains ?? []), ...(rx.domains ?? [])] };
    },
  },
  {
    name: 'pihole_stats_summary',
    description: 'Returns /api/stats/summary.',
    schema: z.object({ instance: Instance }),
    handler: async (args) => getClient(args.instance).statsSummary(),
  },
  {
    name: 'pihole_reload_lists',
    description: 'POST /api/action/gravity to reload gravity.',
    schema: z.object({ instance: Instance }),
    handler: async (args) => getClient(args.instance).reloadGravity(),
  },
  {
    name: 'pihole_group_management',
    description: 'List/create/update/delete Pi-hole groups via /api/groups.',
    schema: z.object({
      instance: Instance,
      action:   z.enum(['list', 'create', 'update', 'delete']),
      group_id: z.number().int().optional(),
      name:     z.string().optional(),
      enabled:  z.boolean().optional(),
      comment:  z.string().optional(),
    }),
    handler: async (args) => getClient(args.instance).groups(args.action, args),
  },
  {
    name: 'pihole_check_regex_types',
    description:
      'READ-ONLY landmine detector: finds deny-exact entries containing regex metacharacters ' +
      '(likely miscategorized). Runs on all instances unless one is specified.',
    schema: z.object({
      instance: z.string().optional()
        .describe('Target a specific instance, or omit to scan all.'),
    }),
    handler: async (args) => {
      const targets = args.instance ? [args.instance] : allInstanceNames();
      return { results: await Promise.all(targets.map(n => getClient(n).checkRegexTypes())) };
    },
  },
  {
    name: 'pihole_set_blocking',
    description:
      'Enable or disable Pi-hole DNS blocking, optionally for a limited time ' +
      '(POST /api/dns/blocking). Set blocking=false to pause ad-blocking; supply ' +
      'timer (seconds) to auto-revert afterwards, or omit for a permanent change.',
    schema: z.object({
      instance: Instance,
      blocking: z.boolean().describe('true = enable blocking, false = disable (pause).'),
      timer: z.number().int().positive().optional()
        .describe('Optional seconds after which blocking auto-reverts. Omit for permanent.'),
    }),
    handler: async (args) => getClient(args.instance).setBlocking(args.blocking, args.timer),
  },
  {
    name: 'pihole_domain_management',
    description:
      'Update or delete an existing allow/deny list domain ' +
      '(PUT/DELETE /api/domains/{allow,deny}/{exact,regex}/{domain}). ' +
      'Completes the CRUD alongside the add/list tools. update preserves any ' +
      'fields you omit (read-modify-write).',
    schema: z.object({
      instance:  Instance,
      action:    z.enum(['update', 'delete']),
      list_type: z.enum(['allow', 'deny']),
      kind:      z.enum(['exact', 'regex']),
      domain:    z.string().min(1),
      comment:   z.string().optional().describe('update only: new comment (omit to clear).'),
      enabled:   z.boolean().optional().describe('update only: enable/disable the entry.'),
      groups:    z.array(z.number().int()).optional()
        .describe('update only: group IDs the entry belongs to. Defaults to [0] if omitted.'),
    }),
    handler: async (args) => {
      const c = getClient(args.instance);
      if (args.action === 'delete') {
        return c.deleteDomain(args.list_type, args.kind, args.domain);
      }
      return c.updateDomain(args.list_type, args.kind, args.domain, {
        comment: args.comment, groups: args.groups, enabled: args.enabled,
      });
    },
  },
  {
    name: 'pihole_local_dns',
    description:
      'Manage local DNS A records (config.dns.hosts). action=list|add|delete; ' +
      'add/delete require ip and domain.',
    schema: z.object({
      instance: Instance,
      action:   z.enum(['list', 'add', 'delete']),
      ip:       z.string().optional().describe('IP address to map (add/delete).'),
      domain:   z.string().optional().describe('Hostname to map (add/delete).'),
    }),
    handler: async (args) => {
      const c = getClient(args.instance);
      if (args.action === 'list') return c.listLocalDNS();
      if (!args.ip || !args.domain) throw new Error('add/delete require both ip and domain');
      return args.action === 'add'
        ? c.addLocalDNS(args.ip, args.domain)
        : c.deleteLocalDNS(args.ip, args.domain);
    },
  },
  {
    name: 'pihole_local_cname',
    description:
      'Manage local CNAME records (config.dns.cnameRecords). action=list|add|delete; ' +
      'add/delete require domain and target, ttl optional.',
    schema: z.object({
      instance: Instance,
      action:   z.enum(['list', 'add', 'delete']),
      domain:   z.string().optional().describe('CNAME alias (add/delete).'),
      target:   z.string().optional().describe('Canonical target the alias points to (add/delete).'),
      ttl:      z.number().int().positive().optional().describe('Optional TTL in seconds.'),
    }),
    handler: async (args) => {
      const c = getClient(args.instance);
      if (args.action === 'list') return c.listCnames();
      if (!args.domain || !args.target) throw new Error('add/delete require both domain and target');
      return args.action === 'add'
        ? c.addCname(args.domain, args.target, args.ttl)
        : c.deleteCname(args.domain, args.target, args.ttl);
    },
  },
];
