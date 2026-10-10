// 個股新聞：按「分析」時才抓 Google News RSS，透過公開 CORS proxy（依序備援）。只取標題、來源、時間、連結。

const TIMEOUT_MS = 8000;
const MAX_ITEMS = 5;

const LOCALE = {
  TW: 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  US: 'hl=en-US&gl=US&ceid=US:en',
};

export function newsQuery(market, code, name) {
  if (market === 'US') return `${code} stock when:7d`;
  const n = name && name !== code ? name : `${code} 股票`;
  return `${n} when:7d`;
}

export const newsUrl = (market, code, name) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(newsQuery(market, code, name))}&${LOCALE[market] ?? LOCALE.TW}`;

const isHttp = (u) => /^https?:\/\//i.test(String(u ?? '').trim());

export function parseRss(text) {
  const doc = new DOMParser().parseFromString(String(text ?? ''), 'text/xml');
  if (doc.querySelector('parsererror') || !doc.querySelector('channel')) throw new Error('不是 RSS');
  return [...doc.querySelectorAll('item')].map((it) => ({
    title: it.querySelector('title')?.textContent ?? '',
    link: it.querySelector('link')?.textContent ?? '',
    pubDate: it.querySelector('pubDate')?.textContent ?? '',
    source: it.querySelector('source')?.textContent ?? '',
  }));
}

const xmlProxy = (build) => async (url, signal) => {
  const res = await fetch(build(url), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRss(await res.text());
};

const PROXIES = [
  { name: 'corsproxy.io', get: xmlProxy((u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`) },
  { name: 'codetabs', get: xmlProxy((u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`) },
  { name: 'allorigins', get: xmlProxy((u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`) },
  {
    name: 'rss2json',
    get: async (u, signal) => {
      const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(u)}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j?.status !== 'ok' || !Array.isArray(j.items)) throw new Error('rss2json');
      return j.items.map((it) => ({
        title: it.title ?? '',
        link: it.link ?? '',
        pubDate: it.pubDate ? `${String(it.pubDate).replace(' ', 'T')}Z` : '',
        source: it.author ?? '',
      }));
    },
  },
];

let preferred = 0;

function withTimeout(run, outer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  return run(ctrl.signal).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  });
}

function clean(items, limit) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    let title = String(it.title ?? '').replace(/\s+/g, ' ').trim();
    let source = String(it.source ?? '').trim();
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    else if (!source) {
      const m = title.match(/^(.*\S)\s+-\s+([^-]+)$/);
      if (m) [, title, source] = m;
    }
    const link = String(it.link ?? '').trim();
    if (!title || !isHttp(link) || seen.has(title)) continue;
    seen.add(title);
    const t = Date.parse(it.pubDate);
    out.push({ title, source, link, pubDate: Number.isNaN(t) ? '' : new Date(t).toISOString() });
  }
  out.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  return out.slice(0, limit);
}

// 依序試每個 proxy；成功的那個下次優先。全部失敗丟出錯誤。
export async function fetchFeed(url, { signal, limit = MAX_ITEMS } = {}) {
  for (let k = 0; k < PROXIES.length; k++) {
    if (signal?.aborted) throw new Error('aborted');
    const i = (preferred + k) % PROXIES.length;
    try {
      const items = clean(await withTimeout((s) => PROXIES[i].get(url, s), signal), limit);
      preferred = i;
      return items;
    } catch {
      // 換下一個 proxy
    }
  }
  throw new Error('所有新聞來源都失敗');
}

// list: [{ key, market, code, name }] → { news: { key: items[] }, ok, failed }
export async function fetchStockNews(list, { signal, onProgress, concurrency = 3 } = {}) {
  const news = {};
  let ok = 0, failed = 0, done = 0, giveUp = false;
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (giveUp || signal?.aborted) {
        failed++;
      } else {
        try {
          news[item.key] = await fetchFeed(newsUrl(item.market, item.code, item.name), { signal });
          ok++;
        } catch {
          failed++;
          // 前兩檔都抓不到時，proxy 大概全掛了，其餘直接略過以免讓使用者久等。
          if (ok === 0 && failed >= 2) giveUp = true;
        }
      }
      done++;
      onProgress?.(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { news, ok, failed };
}
