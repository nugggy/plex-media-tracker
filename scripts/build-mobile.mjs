// Builds www/ for the Android app: the dashboard from public/, plus the small
// client that sends its calls to the server on the NAS.
import { build } from 'esbuild';
import { rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
rmSync(`${root}/www`, { recursive: true, force: true });
cpSync(`${root}/public`, `${root}/www`, { recursive: true });

await build({
  entryPoints: [`${root}/mobile/entry.ts`],
  outdir: `${root}/www/mobile`,
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  publicPath: '/mobile',
  logLevel: 'warning',
});

// Nothing Node-only may reach the phone. A leak here means the client has
// started importing server code.
for (const f of readdirSync(`${root}/www/mobile`).filter((n) => n.endsWith('.js'))) {
  const text = readFileSync(`${root}/www/mobile/${f}`, 'utf8');
  const leak = text.match(/from\s*["']node:[a-z/]+["']|require\(["']node:[a-z/]+["']\)/);
  if (leak) throw new Error(`Node-only import in www/mobile/${f}: ${leak[0]}`);
}

const html = `${root}/www/index.html`;
const page = readFileSync(html, 'utf8');
const tag = '<script type="module" src="/app.js"></script>';
if (!page.includes(tag)) throw new Error('index.html no longer loads /app.js as expected');
writeFileSync(
  html,
  page.replace(tag, `<script type="module" src="/mobile/entry.js"></script>\n    ${tag}`),
);
console.log('www/ built for Android');
