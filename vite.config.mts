import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const DEV_PORT = 5173;

/**
 * Fills the Content-Security-Policy placeholder in index.html. Dev mode needs inline
 * scripts (React Refresh preamble) and the HMR websocket; production gets a strict policy.
 */
function contentSecurityPolicy(dev: boolean): Plugin {
  const prod = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const devPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    `connect-src 'self' ws://localhost:${DEV_PORT} http://localhost:${DEV_PORT}`,
    "object-src 'none'",
  ];
  const policy = (dev ? devPolicy : prod).join('; ');
  return {
    name: 'aco-content-security-policy',
    transformIndexHtml: (html) => html.replace('%CONTENT_SECURITY_POLICY%', policy),
  };
}

export default defineConfig(({ command }) => ({
  root: `${rootDir}src/renderer`,
  base: './',
  plugins: [react(), contentSecurityPolicy(command === 'serve')],
  server: { port: DEV_PORT, strictPort: true },
  build: {
    outDir: `${rootDir}dist/renderer`,
    emptyOutDir: true,
    // Fonts stay as real files instead of being inlined as base64.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
}));
