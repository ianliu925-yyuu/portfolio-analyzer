// Builds the preview dataset (fixtures/site-latest) by running the real pipeline on the fixtures,
// with nine earlier days of 法人/融資 history seeded so streaks and 5-day sums look realistic.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../fetch-data.mjs';
import { twCalendar } from '../../lib/calendar.mjs';
import { saveBuckets } from '../../lib/store.mjs';
import { parseTpexMargin } from '../../lib/tpex.mjs';
import { parseHolidays, parseMarginDated } from '../../lib/twse.mjs';
import { twBucket } from '../../lib/util.mjs';
import { createFakeMarket, fixtureJson, hash, noSleep, quiet, rng } from './fake-market.mjs';

export const FIXTURE_NOW = new Date('2026-10-10T23:17:05Z'); // Mon 07:17 in Taipei
export const FIXTURE_AS_OF = '2026-10-08';

export function seedChips() {
  const cal = twCalendar(parseHolidays(fixtureJson('twse/holidaySchedule.json')));
  const days = [];
  for (let d = cal.prev(FIXTURE_AS_OF); days.length < 9; d = cal.prev(d)) days.unshift(d);

  const prevBalance = {};
  for (const [code, m] of Object.entries(parseMarginDated(fixtureJson('twse/MI_MARGN_20261008.json')).map)) {
    prevBalance[code] = m.margin - m.marginChg;
  }
  for (const [code, m] of Object.entries(parseTpexMargin(fixtureJson('tpex/tpex_mainboard_margin_balance.json')).map)) {
    prevBalance[code] = m.margin - m.marginChg;
  }

  // per-code bias: positive codes were mostly bought by foreign investors in the days before
  const bias = { 2330: 0.75, 2317: -0.7, 2454: -0.3, 4971: 0.8, 5351: -0.8, '0050': -0.2, '00679B': 0.9, 6488: 0.4, 8069: -0.6 };
  const codes = [
    ...fixtureJson('twse/T86_20261008.json').data.map((r) => r[0].trim()),
    ...fixtureJson('tpex/tpex_3insti_daily_trading.json').map((r) => r.SecuritiesCompanyCode),
  ];
  const chips = {};
  for (const code of codes) {
    const rand = rng(hash(`chips:${code}`));
    const b = bias[code] ?? 0;
    const scale = code === '2330' ? 4_000_000 : code.startsWith('00') ? 2_000_000 : 400_000;
    const sign = (p) => (rand() < (1 + p) / 2 ? 1 : -1);
    let balance = prevBalance[code];
    const entries = [];
    for (let i = days.length - 1; i >= 0; i--) {
      const entry = {
        date: days[i],
        foreign: sign(b) * Math.round(scale * (0.2 + rand())),
        trust: sign(b / 2) * Math.round((scale / 8) * rand()),
        dealer: sign(0) * Math.round((scale / 10) * rand()),
      };
      if (balance != null) {
        const chg = Math.round((rand() - 0.5) * balance * 0.03);
        Object.assign(entry, { margin: balance, marginChg: chg, short: Math.round(balance * 0.02 * rand()) });
        balance -= chg;
      }
      entries.unshift(entry);
    }
    chips[code] = entries;
  }
  return chips;
}

// Runs the pipeline into a fresh temp store and returns its path (caller removes it).
export async function buildSiteFixture() {
  const store = await mkdtemp(join(tmpdir(), 'site-fixture-'));
  try {
    await saveBuckets(join(store, 'history', 'chips'), seedChips(), twBucket);
    const market = createFakeMarket();
    const result = await run({ store, out: store, fetch: market.fetch, now: FIXTURE_NOW, env: {}, log: quiet, sleep: noSleep });
    if (result.exitCode !== 0) throw new Error(`pipeline exit ${result.exitCode}`);
    return store;
  } catch (err) {
    await rm(store, { recursive: true, force: true });
    throw err;
  }
}
