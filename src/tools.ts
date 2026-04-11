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
];
