import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SUMMER_CRON, WINTER_CRON, decide } from '../decide.mjs';

const summer = new Date('2026-10-12T12:17:00Z'); // EDT
const winter = new Date('2026-11-02T13:17:00Z'); // EST

test('scheduled runs: the pre-US-open slot that does not match DST is skipped', () => {
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: SUMMER_CRON, hasData: true, now: summer })), [true, true]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: WINTER_CRON, hasData: true, now: summer })), [false, false]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: WINTER_CRON, hasData: true, now: winter })), [true, true]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: SUMMER_CRON, hasData: true, now: winter })), [false, false]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: '17 23 * * 0-4', hasData: true, now: winter })), [true, true]);
});

test('push deploys existing data and fetches only when the data branch is empty', () => {
  assert.deepEqual(pick(decide({ event: 'push', hasData: true })), [false, true]);
  assert.deepEqual(pick(decide({ event: 'push', hasData: false })), [true, true]);
});

test('workflow_dispatch fetches unless force_fetch is false', () => {
  assert.deepEqual(pick(decide({ event: 'workflow_dispatch', forceFetch: 'true', hasData: true })), [true, true]);
  assert.deepEqual(pick(decide({ event: 'workflow_dispatch', forceFetch: 'false', hasData: true })), [false, true]);
  assert.deepEqual(pick(decide({ event: 'workflow_dispatch', forceFetch: 'false', hasData: false })), [true, true]);
});

test('workflow file wires the crons the decision script expects', () => {
  const yml = readFileSync(new URL('../../.github/workflows/site.yml', import.meta.url), 'utf8');
  for (const cron of ['17 23 * * 0-4', SUMMER_CRON, WINTER_CRON]) assert.ok(yml.includes(`cron: '${cron}'`), cron);
  for (const needle of [
    'contents: write',
    'pages: write',
    'id-token: write',
    'group: site',
    'cancel-in-progress: false',
    'timeout-minutes: 60',
    'force_fetch',
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'node-version: 20',
    'node scripts/decide.mjs',
    'node scripts/fetch-data.mjs --store store --out store',
    'git push -q --force',
    'actions/configure-pages@v5',
    'actions/upload-pages-artifact@v3',
    'actions/deploy-pages@v4',
    'name: github-pages',
    'cp -R store/latest _site/data/latest',
  ]) {
    assert.ok(yml.includes(needle), needle);
  }
  assert.ok(!/cp -R (scripts|docs|\.github)/.test(yml), 'scripts/, docs/ and .github are not published');
});

const pick = (d) => [d.fetch, d.deploy];
