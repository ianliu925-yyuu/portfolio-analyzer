// 讀每日資料（data/latest/）與代號搜尋。只載入目前持股需要的分桶，結果快取在記憶體。

const BASE = new URL('../data/latest/', import.meta.url);

let metaPromise = null;
let version = '';
const indexCache = new Map();   // market → Promise<rows>
const bucketCache = new Map();  // 'TW/23' → Promise<{ code: record }>
const failedBuckets = new Set();

async function getJson(path, { revalidate = false } = {}) {
  const url = new URL(path, BASE);
  if (version && !revalidate) url.searchParams.set('v', version);
  const res = await fetch(url, revalidate ? { cache: 'no-cache' } : undefined);
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

export function loadMeta({ retry = false } = {}) {
  if (!metaPromise || retry) {
    metaPromise = getJson('meta.json', { revalidate: true }).then((meta) => {
      if (!meta || typeof meta !== 'object' || !meta.tw || !meta.us) throw new Error('meta.json 格式不正確');
      version = String(meta.generatedAt ?? '');
      return meta;
    });
    metaPromise.catch(() => { metaPromise = null; });
  }
  return metaPromise;
}

export function bucketOf(market, code) {
  const c = String(code ?? '').trim().toUpperCase();
  return market === 'US' ? c.slice(0, 1) : c.slice(0, 2);
}

// [[code, name, type], …]；載入失敗時為 null，且不快取失敗結果（下次呼叫會再試）。
export function loadIndex(market) {
  if (!indexCache.has(market)) {
    const file = market === 'US' ? 'index-us.json' : 'index-tw.json';
    const p = getJson(file)
      .then((rows) => (Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && r[0]) : []))
      .catch(() => {
        indexCache.delete(market);
        return null;
      });
    indexCache.set(market, p);
  }
  return indexCache.get(market);
}

function loadBucket(market, bucket) {
  const key = `${market}/${bucket}`;
  if (!bucketCache.has(key)) {
    const dir = market === 'US' ? 'us' : 'tw';
    const p = getJson(`${dir}/${encodeURIComponent(bucket)}.json`)
      .then((data) => {
        failedBuckets.delete(key);
        return data && typeof data === 'object' ? data : {};
      })
      .catch((err) => {
        // 404 = 這個分桶沒有任何代號（不是錯誤）；其他錯誤下次再試。
        if (err.status === 404) return {};
        failedBuckets.add(key);
        bucketCache.delete(key);
        return {};
      });
    bucketCache.set(key, p);
  }
  return bucketCache.get(key);
}

// items: [{ market, code }] → { 'TW:2330': record }（找不到的不放）
export async function loadRecords(items) {
  const wanted = new Map();
  for (const { market, code } of items) {
    const b = bucketOf(market, code);
    if (!b || !/^[0-9A-Z]+$/.test(b)) continue;
    wanted.set(`${market}/${b}`, { market, bucket: b });
  }
  const loaded = await Promise.all([...wanted.values()].map(({ market, bucket }) =>
    loadBucket(market, bucket).then((data) => ({ market, data }))));
  const out = {};
  for (const { market, code } of items) {
    const c = String(code).trim().toUpperCase();
    const hit = loaded.find((l) => l.market === market && l.data[c]);
    if (hit) out[`${market}:${c}`] = hit.data[c];
  }
  return out;
}

export const hasFailedBuckets = () => failedBuckets.size > 0;

// 代號搜尋：代號開頭相符優先，再來是名稱包含。
export function searchIndex(rows, query, limit = 8) {
  const q = String(query ?? '').trim().toUpperCase();
  if (!q || !Array.isArray(rows)) return [];
  const starts = [];
  const contains = [];
  for (const r of rows) {
    const code = String(r[0]).toUpperCase();
    const name = String(r[1] ?? '');
    if (code === q || code.startsWith(q)) starts.push(r);
    else if (name.toUpperCase().includes(q)) contains.push(r);
    if (starts.length >= limit) break;
  }
  starts.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
  return [...starts, ...contains].slice(0, limit);
}

export function findInIndex(rows, code) {
  const c = String(code ?? '').trim().toUpperCase();
  return Array.isArray(rows) ? rows.find((r) => String(r[0]).toUpperCase() === c) ?? null : null;
}
