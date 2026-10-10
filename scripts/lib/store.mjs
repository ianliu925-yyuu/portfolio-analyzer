// JSON file helpers for the data branch checkout (history/ and latest/).
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export async function writeJson(file, data, { pretty = false } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, pretty ? 2 : 0) + '\n');
  await rename(tmp, file);
}

async function jsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Merge every {bucket}.json in dir into one { code: value } object.
export async function loadBuckets(dir) {
  const out = {};
  for (const f of await jsonFiles(dir)) Object.assign(out, await readJson(join(dir, f), {}));
  return out;
}

// Split { code: value } into {bucket}.json files (sorted keys) and delete buckets that became empty.
export async function saveBuckets(dir, data, bucketOf) {
  const groups = {};
  for (const code of Object.keys(data).sort()) (groups[bucketOf(code)] ??= {})[code] = data[code];
  await mkdir(dir, { recursive: true });
  for (const [bucket, group] of Object.entries(groups)) await writeJson(join(dir, `${bucket}.json`), group);
  for (const f of await jsonFiles(dir)) if (!groups[f.slice(0, -5)]) await rm(join(dir, f));
  return Object.keys(groups).sort();
}

// Swap a fully written temp directory into place so readers never see a half-written latest/.
export async function swapDir(tmpDir, finalDir) {
  const old = `${finalDir}.old`;
  await rm(old, { recursive: true, force: true });
  try {
    await rename(finalDir, old);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await rename(tmpDir, finalDir);
  await rm(old, { recursive: true, force: true });
}
