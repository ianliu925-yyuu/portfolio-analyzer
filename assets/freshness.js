// 每日資料是否落後（純函式）。只用 meta 裡已有的 asOf／nextTradingDay，不需要休市日曆。
//
// 交易日 N 收盤後，下一次台灣清晨的排程（週一到週六）會抓到它：台股在 N+1 日早上，
// 美股收盤時台灣已經是 N+1 日凌晨。N 一定是平日，N+1 落在週二到週六，都有排程。
// 排程 05:47 開始、GitHub 常晚 2.5 小時左右，所以到台灣 N+1 日 10:30 還沒有 N 的資料，就算落後。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAIPEI_OFFSET_H = 8; // 台灣沒有日光節約時間
export const DUE_AT = { hour: 10, minute: 30 };

// 台灣時間 iso 日期的隔天 DUE_AT，換成 epoch 毫秒。
function dueAfter(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1, DUE_AT.hour - TAIPEI_OFFSET_H, DUE_AT.minute);
}

function marketFreshness(m, nowMs) {
  const next = m?.nextTradingDay;
  if (!DATE_RE.test(String(next ?? ''))) return null;
  const asOf = DATE_RE.test(String(m.asOf ?? '')) ? m.asOf : null;
  return { asOf, expected: next, stale: (!asOf || asOf < next) && nowMs >= dueAfter(next) };
}

export function dataFreshness(meta, now = new Date()) {
  if (!meta || typeof meta !== 'object') return null;
  const nowMs = now.getTime();
  const generated = Date.parse(meta.generatedAt ?? '');
  return {
    ageHours: Number.isFinite(generated) ? Math.max(0, (nowMs - generated) / 3_600_000) : null,
    tw: marketFreshness(meta.tw, nowMs),
    us: marketFreshness(meta.us, nowMs),
  };
}
