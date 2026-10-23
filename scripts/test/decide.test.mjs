import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SUMMER_CRON, WINTER_CRON, decide } from '../decide.mjs';

const WORKFLOW = new URL('../../.github/workflows/site.yml', import.meta.url);

const summer = new Date('2026-10-12T12:17:00Z'); // EDT
const winter = new Date('2026-11-02T13:17:00Z'); // EST

test('scheduled runs: the pre-US-open slot that does not match DST is skipped', () => {
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: SUMMER_CRON, hasData: true, now: summer })), [true, true]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: WINTER_CRON, hasData: true, now: summer })), [false, false]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: WINTER_CRON, hasData: true, now: winter })), [true, true]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: SUMMER_CRON, hasData: true, now: winter })), [false, false]);
  assert.deepEqual(pick(decide({ event: 'schedule', schedule: '47 21 * * 0-5', hasData: true, now: winter })), [true, true]);
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
  const yml = readFileSync(WORKFLOW, 'utf8');
  for (const cron of ['47 21 * * 0-5', SUMMER_CRON, WINTER_CRON]) assert.ok(yml.includes(`cron: '${cron}'`), cron);
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

// The `run: |` block of a workflow step, de-indented.
function stepScript(yml, name) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)[0];
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && !l.startsWith(indent)) break;
    body.push(l.slice(indent.length));
  }
  return body.join('\n');
}

const gitOk = spawnSync('git', ['--version']).status === 0;

test('workflow: the data branch is loaded, created or the job stops, by ls-remote exit code', { skip: !gitOk && 'git not installed' }, (t) => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), 'Check out the data branch into ./store');
  assert.match(script, /git ls-remote --exit-code origin refs\/heads\/data/);

  const root = mkdtempSync(join(tmpdir(), 'site-yml-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  // a remote whose branches each hold one commit with the given files
  const remote = (name, branches) => {
    const bare = join(root, `${name}.git`);
    git(root, 'init', '-q', '--bare', bare);
    for (const [branch, files] of Object.entries(branches)) {
      const work = join(root, `${name}-${branch.replace('/', '-')}`);
      git(root, 'init', '-q', '-b', 'tmp', work);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(work, path, '..'), { recursive: true });
        writeFileSync(join(work, path), text);
      }
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '--allow-empty', '-m', branch);
      git(work, 'push', '-q', bare, `HEAD:refs/heads/${branch}`);
    }
    return bare;
  };
  const runStep = (origin) => {
    const cwd = join(root, `job-${Math.random().toString(36).slice(2)}`);
    git(root, 'init', '-q', '-b', 'main', cwd);
    git(cwd, 'remote', 'add', 'origin', origin);
    const r = spawnSync('bash', ['-e', '-c', script], { cwd, env, encoding: 'utf8' });
    return { ...r, store: join(cwd, 'store') };
  };

  const loaded = runStep(remote('with-data', { main: { 'index.html': '' }, data: { 'latest/meta.json': '{"schema":1}' } }));
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /data branch loaded/);
  assert.equal(readFileSync(join(loaded.store, 'latest', 'meta.json'), 'utf8'), '{"schema":1}');

  const fresh = runStep(remote('no-data', { main: { 'index.html': '' }, 'feature/data': { 'x.txt': 'x' } }));
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /does not exist yet/, 'refs/heads/feature/data is not the data branch');
  assert.equal(existsSync(join(fresh.store, 'x.txt')), false);

  const down = runStep(join(root, 'unreachable.git'));
  assert.notEqual(down.status, 0, 'an unreachable remote must fail the job, not start an empty store');
  assert.match(down.stdout, /::error::git ls-remote failed \(exit 128\)/);
});

const pick = (d) => [d.fetch, d.deploy];
