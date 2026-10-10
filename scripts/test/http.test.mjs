import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_UA, createLimiter, getJson, getText } from '../lib/http.mjs';

function scripted(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? '', { status: next.status ?? 200, headers: next.headers ?? {} });
  };
  return { fetch, calls };
}

test('retries 429 and 5xx with exponential backoff, honouring Retry-After', async () => {
  const { fetch, calls } = scripted([{ status: 503 }, { status: 429, headers: { 'retry-after': '5' } }, { body: 'ok' }]);
  const waits = [];
  const text = await getText('https://example.test/a', { fetch, sleep: async (ms) => waits.push(ms), baseDelayMs: 100 });
  assert.equal(text, 'ok');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [100, 5000]);
  assert.equal(calls[0].init.headers['User-Agent'], BROWSER_UA);
  assert.ok(calls[0].init.signal, 'request carries a timeout signal');
});

test('does not retry other 4xx and gives up after the retry budget', async () => {
  const notFound = scripted([{ status: 404 }]);
  await assert.rejects(getText('https://example.test/x', { fetch: notFound.fetch, sleep: async () => {} }), { status: 404 });
  assert.equal(notFound.calls.length, 1);

  const down = scripted([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(getText('https://example.test/y', { fetch: down.fetch, sleep: async () => {}, retries: 2 }), { status: 500 });
  assert.equal(down.calls.length, 3);
});

test('network errors and timeouts are retried', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { fetch, calls } = scripted([timeout, new TypeError('fetch failed'), { body: '{"a":1}' }]);
  assert.deepEqual(await getJson('https://example.test/z', { fetch, sleep: async () => {} }), { a: 1 });
  assert.equal(calls.length, 3);
});

test('getJson strips a BOM and rejects HTML maintenance pages', async () => {
  const bom = scripted([{ body: '﻿[1,2]' }]);
  assert.deepEqual(await getJson('https://example.test/bom', { fetch: bom.fetch }), [1, 2]);
  const html = scripted([{ body: '<!DOCTYPE html><title>網站維護中</title>' }]);
  await assert.rejects(getJson('https://example.test/html', { fetch: html.fetch }), /not JSON/);
});

test('limiter caps concurrency and spaces starts', async () => {
  const waits = [];
  const limit = createLimiter({ concurrency: 2, minIntervalMs: 350, sleep: async (ms) => waits.push(ms) });
  let active = 0;
  let peak = 0;
  const job = (v) => async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return v;
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(job(v))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.ok(waits.length >= 3 && waits.every((ms) => ms > 0 && ms <= 350 * 5), `waits ${waits}`);
});
