// Bundles the TypeScript feed builder with esbuild (already a dev dependency) and runs it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outfile = join(mkdtempSync(join(tmpdir(), 'catalog-feed-')), 'update-feed.mjs');
await build({
  entryPoints: ['scripts/catalog/updateFeed.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
});
await import(pathToFileURL(outfile).href);
