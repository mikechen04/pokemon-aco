// Production build: main + preload with esbuild, renderer with Vite. Output goes to dist/.
import { rm } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mainOptions, preloadOptions } from './esbuild.config.mjs';

await rm('dist', { recursive: true, force: true });

await Promise.all([esbuild(mainOptions(false)), esbuild(preloadOptions(false))]);
await viteBuild({ configFile: 'vite.config.mts', mode: 'production' });

console.log('\nBuild complete: dist/main, dist/preload, dist/renderer');
