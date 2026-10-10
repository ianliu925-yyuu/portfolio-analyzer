// fetch wrapper: browser User-Agent, timeout, retry with exponential backoff on 429/5xx.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

const retryable = (status) => status === 429 || status >= 500;

export async function getText(url, opts = {}) {
  const {
    fetch = globalThis.fetch,
    sleep: wait = sleep,
    headers = {},
    timeoutMs = 30_000,
    retries = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    log = () => {},
  } = opts;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.ok) return await res.text();
      await res.body?.cancel?.().catch(() => {});
      const err = new HttpError(`HTTP ${res.status} ${url}`, res.status, url);
      if (!retryable(res.status)) throw err;
      const after = Number(res.headers?.get?.('retry-after'));
      if (after > 0) delay = Math.min(maxDelayMs, Math.max(delay, after * 1000));
      lastError = err;
    } catch (err) {
      if (err instanceof HttpError && !retryable(err.status)) throw err;
      lastError = err instanceof HttpError ? err : new HttpError(`${err.name}: ${err.message} ${url}`, 0, url);
    }
    if (attempt < retries) {
      log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${lastError.message}`);
      await wait(delay);
    }
  }
  throw lastError;
}

export async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    const head = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new HttpError(`not JSON from ${url}: ${head}`, 200, url);
  }
}

// limit(fn) runs fn with at most `concurrency` in flight and >= minIntervalMs between starts.
export function createLimiter({ concurrency = 2, minIntervalMs = 0, sleep: wait = sleep } = {}) {
  let active = 0;
  let nextStart = 0;
  const queue = [];
  const pump = () => {
    while (active < concurrency && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      const now = Date.now();
      const delay = Math.max(0, nextStart - now);
      nextStart = Math.max(now, nextStart) + minIntervalMs;
      (delay ? wait(delay) : Promise.resolve())
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}
