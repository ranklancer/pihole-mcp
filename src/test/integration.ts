import { getClient, allInstanceNames } from '../instances.js';

/**
 * Quick integration smoke test — runs against the first configured instance.
 * Usage:  PIHOLE_INSTANCES=mypihole MYPIHOLE_BASE_URL=http://... MYPIHOLE_PASSWORD=... node dist/test/integration.js
 */
async function main() {
  const instanceName = allInstanceNames()[0];
  console.log(`Testing instance: ${instanceName}`);
  const c = getClient(instanceName);

  console.log('--- version ---');
  console.log(JSON.stringify(await c.version(), null, 2));

  console.log('--- stats/summary ---');
  const s = await c.statsSummary();
  console.log('queries.total =', s.queries?.total, 'blocked =', s.queries?.blocked, 'percent =', s.queries?.percent_blocked);

  console.log('--- check_regex_types ---');
  console.log(JSON.stringify(await c.checkRegexTypes(), null, 2));

  await c.logout();
  console.log('OK');
}

main().catch(err => { console.error(err); process.exit(1); });
