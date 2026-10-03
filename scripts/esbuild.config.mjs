// Shared esbuild options for the Electron main process and the preload script.
// Both are bundled into single CommonJS files so the packaged app ships no node_modules.

/** @param {boolean} dev */
function common(dev) {
  return {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    legalComments: 'none',
    logLevel: 'info',
    // The app icon is imported by the main process and inlined.
    loader: { '.png': 'dataurl' },
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
  };
}

/** @param {boolean} dev */
export function mainOptions(dev) {
  return {
    ...common(dev),
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
  };
}

/**
 * The preload runs in a sandboxed renderer, where `require` only resolves `electron`,
 * so it must be one self-contained file.
 * @param {boolean} dev
 */
export function preloadOptions(dev) {
  return {
    ...common(dev),
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
  };
}
