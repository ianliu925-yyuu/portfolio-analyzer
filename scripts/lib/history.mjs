// Price/volume history and chip (法人/融資) history, plus the indicators derived from them.
import { round, roundPx } from './util.mjs';

export const MAX_BARS = 260;
export const MAX_CHIP_DAYS = 10;
export const MIN_BARS = 30; // fewer than this -> bootstrap from Yahoo

const byDate = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// bars are [date, close, volume] ascending. On a date clash `prefer` wins; its nulls are filled from the other.
export function mergeBars(existing = [], incoming = [], { prefer = 'incoming', max = MAX_BARS } = {}) {
  const map = new Map(existing.map((b) => [b[0], b]));
  for (const b of incoming) {
    if (!b || !b[0] || !(b[1] > 0)) continue;
    const cur = map.get(b[0]);
    if (!cur) map.set(b[0], [b[0], b[1], b[2] ?? null]);
    else {
      const [win, lose] = prefer === 'incoming' ? [b, cur] : [cur, b];
      map.set(b[0], [b[0], win[1] ?? lose[1], win[2] ?? lose[2] ?? null]);
    }
  }
  return [...map.values()].sort(byDate).slice(-max);
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function computeHist(bars = []) {
  const closes = bars.map((b) => b[1]);
  const n = closes.length;
  const last = closes[n - 1];
  const back = (k) => (n > k && closes[n - 1 - k] > 0 ? round((last / closes[n - 1 - k] - 1) * 100, 2) : null);
  const last20 = closes.slice(-20);
  const year = closes.slice(-250);
  const vols = bars
    .slice(-20)
    .map((b) => b[2])
    .filter((v) => Number.isFinite(v));
  const full20 = n >= 20;
  return {
    days: n,
    d5Pct: back(5),
    d20Pct: back(20),
    hi52: full20 ? Math.max(...year) : null,
    lo52: full20 ? Math.min(...year) : null,
    ma20: full20 ? roundPx(mean(last20)) : null,
    ma60: n >= 60 ? roundPx(mean(closes.slice(-60))) : null,
    avgVol20: full20 && vols.length >= 10 ? Math.round(mean(vols)) : null,
    low20: full20 ? Math.min(...last20) : null,
    high20: full20 ? Math.max(...last20) : null,
  };
}

// entries: [{date, foreign, trust, dealer, margin, marginChg, short}] ascending; fields from
// different sources for the same date are merged into one entry.
export function mergeChip(entries = [], date, fields, max = MAX_CHIP_DAYS) {
  if (!date) return entries;
  const current = entries.find((e) => e.date === date) ?? { date };
  const rest = entries.filter((e) => e.date !== date);
  rest.push({ ...current, ...fields, date });
  return rest.sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}

const hasInst = (e) => e.foreign != null || e.trust != null || e.dealer != null;

export function computeChips(entries = []) {
  const inst = entries.filter(hasInst);
  const marg = entries.filter((e) => e.margin != null).at(-1);
  const last = inst.at(-1);
  if (!last && !marg) return null;

  // consecutive same-sign days counted back from the latest; signed (+ buy streak, - sell streak)
  const streak = (field) => {
    const sign = Math.sign(last?.[field] ?? 0);
    if (!sign) return 0;
    let count = 0;
    for (let i = inst.length - 1; i >= 0; i--) {
      const v = inst[i][field];
      if (v == null || Math.sign(v) !== sign) break;
      count++;
    }
    return count * sign;
  };
  const sum5 = (field) => {
    const v = inst
      .slice(-5)
      .map((e) => e[field])
      .filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };

  const chips = {
    date: last?.date ?? marg.date,
    foreign: last?.foreign ?? null,
    trust: last?.trust ?? null,
    dealer: last?.dealer ?? null,
    foreignStreak: last ? streak('foreign') : null,
    trustStreak: last ? streak('trust') : null,
    foreign5: sum5('foreign'),
    trust5: sum5('trust'),
    dealer5: sum5('dealer'),
    margin: marg?.margin ?? null,
    marginChg: marg?.marginChg ?? null,
    short: marg?.short ?? null,
  };
  if (marg && last && marg.date !== last.date) chips.marginDate = marg.date;
  return chips;
}
