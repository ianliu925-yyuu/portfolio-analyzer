#!/usr/bin/env node
// Workflow helper: should this run fetch new data, and should it deploy?
// Reads EVENT_NAME, SCHEDULE, FORCE_FETCH and STORE from the environment and appends
// fetch=… / deploy=… to $GITHUB_OUTPUT (also printed for the log).
import { appendFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isUsDst } from './lib/calendar.mjs';

export const SUMMER_CRON = '17 12 * * 1-5'; // 08:17 EDT, one hour before the US open in summer
export const WINTER_CRON = '17 13 * * 1-5'; // 08:17 EST, one hour before the US open in winter

export function decide({ event, schedule, forceFetch, hasData, now = new Date() }) {
  if (event === 'schedule') {
    const dst = isUsDst(now);
    if ((schedule === SUMMER_CRON && !dst) || (schedule === WINTER_CRON && dst)) {
      return { fetch: false, deploy: false, reason: `skip ${schedule}: New York is on ${dst ? 'EDT' : 'EST'}` };
    }
    return { fetch: true, deploy: true, reason: `scheduled ${schedule}` };
  }
  if (!hasData) return { fetch: true, deploy: true, reason: 'data branch has no latest/meta.json' };
  if (event === 'workflow_dispatch') {
    const force = String(forceFetch ?? 'true') !== 'false';
    return { fetch: force, deploy: true, reason: force ? 'manual run' : 'manual redeploy' };
  }
  return { fetch: false, deploy: true, reason: `${event}: deploy existing data` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  const store = env.STORE ?? 'store';
  const hasData = await access(join(store, 'latest', 'meta.json')).then(
    () => true,
    () => false,
  );
  const d = decide({ event: env.EVENT_NAME, schedule: env.SCHEDULE, forceFetch: env.FORCE_FETCH, hasData });
  const lines = `fetch=${d.fetch}\ndeploy=${d.deploy}\n`;
  console.log(`${lines}reason=${d.reason}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, lines);
}
