// Regenerates scripts/test/fixtures/site-latest/ (a small but complete latest/ dataset for previewing
// the page) by running the pipeline on the fixtures:  node scripts/test/build-site-fixture.mjs
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSiteFixture } from './helpers/site-fixture.mjs';

const target = fileURLToPath(new URL('./fixtures/site-latest', import.meta.url));

// node --test on Node 20 runs every .mjs under scripts/test/; never rewrite fixtures from there.
if (!process.env.NODE_TEST_CONTEXT) {
  const store = await buildSiteFixture();
  await rm(target, { recursive: true, force: true });
  await cp(join(store, 'latest'), target, { recursive: true });
  await rm(store, { recursive: true, force: true });
  console.log(`wrote ${target}`);
}
