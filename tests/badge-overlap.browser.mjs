#!/usr/bin/env node
/**
 * D6 regression — real-browser viewport x scroll sweep for widget-badge click interception.
 *
 *   npm run test:browser        (also: node tests/badge-overlap.browser.mjs)
 *
 * Serves the built `dist/` locally, drives headless Chrome over CDP, and for every viewport in
 * the grid, at 11 scroll fractions from the top to the bottom of the page, for every interactive
 * control, samples the intersection of the control's on-screen box with the viewport and asks
 * `document.elementFromPoint` what is actually on top there. If the topmost element is ever the
 * Chain Jam widget badge, the test fails.
 *
 * HERMETIC BY DESIGN: the real widget is a third-party script whose load we do not control, so
 * the test removes any badge it rendered and INJECTS a synthetic badge with the exact production
 * geometry and z-index established in research/wave1-browser-root-causes.md D6 (fixed,
 * bottom-right, ~158x37, z-index 2147483000). That makes the assertion deterministic and offline,
 * while still validating the fix against the real widget's stacking footprint.
 *
 * Exits 0 on pass, 1 on interception, 2 if Chrome is unavailable (so CI can choose to skip).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const VIEWPORTS = [[320, 568], [360, 640], [390, 700], [390, 844], [768, 1024], [1280, 800]];
const CONTROLS = ['#pickFirst', '#pickSecond', '#wager', '#bet', '#deal', '.tabstrip .tab'];
const PORT = Number(process.env.PORT ?? 8957);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9233);
const PROFILE = `/tmp/handicap-badge-${Date.now()}`;
const CHROME = process.env.CHROME ?? [
  '/home/eya/.agent-browser/browsers/chrome-154.0.8037.57/chrome',
  '/home/eya/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/eya/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('SKIP: no Chrome binary found (set CHROME=/path/to/chrome)');
  process.exit(2);
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is not built — run `npm run build` first');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = path.join(DIST, safe);
  if (rel.endsWith('/')) file = path.join(DIST, safe, 'index.html');
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'content-type': (MIME[path.extname(file)] ?? 'application/octet-stream') + (path.extname(file) === '.js' || path.extname(file) === '.mjs' ? '; charset=utf-8' : '') });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => {});

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws: ' + (e.message ?? ''))));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) { id += 1; const my = id; return new Promise((res, rej) => { pending.set(my, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: my, method, params })); }); },
      close: () => ws.close(),
    }));
  });
}

/** Remove any real badge and inject a synthetic one at the production geometry/z-index. */
const INJECT = `(() => {
  document.querySelectorAll('#chain-jam-badge').forEach((n) => n.remove());
  const a = document.createElement('a');
  a.id = 'chain-jam-badge';
  a.textContent = 'CHAIN JAM VOL.1';
  Object.assign(a.style, {
    position: 'fixed', right: '14px', bottom: '12px', width: '158px', height: '37px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#141416', color: '#fff', zIndex: '2147483000', pointerEvents: 'auto',
  });
  document.body.appendChild(a);
  return a.getBoundingClientRect().width;
})()`;

const SWEEP = `(() => {
  const sels = ${JSON.stringify(CONTROLS)};
  const steps = 11;
  const results = [];
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const samples = { c: [0.5, 0.5], tl: [0.08, 0.1], tr: [0.92, 0.1], bl: [0.08, 0.9], br: [0.92, 0.9] };
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) { results.push({ sel, found: false }); continue; }
    for (let s = 0; s < steps; s += 1) {
      window.scrollTo(0, Math.round(maxScroll * s / (steps - 1)));
      const r = el.getBoundingClientRect();
      const ix0 = Math.max(0, r.left), iy0 = Math.max(0, r.top);
      const ix1 = Math.min(innerWidth, r.right), iy1 = Math.min(innerHeight, r.bottom);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      for (const [nm, [fx, fy]] of Object.entries(samples)) {
        const px = Math.round(ix0 + (ix1 - ix0) * fx);
        const py = Math.round(iy0 + (iy1 - iy0) * fy);
        if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
        const hit = document.elementFromPoint(px, py);
        if (hit && hit.closest && hit.closest('#chain-jam-badge')) {
          results.push({ sel, scrollY: Math.round(scrollY), sample: nm, px, py });
        }
      }
    }
  }
  window.scrollTo(0, 0);
  return { results, docH: document.documentElement.scrollHeight };
})()`;

const failures = [];
let cdp;
try {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i += 1) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null; } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('devtools did not come up');
  cdp = await connect(wsUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const evalIn = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
    return r.result?.value;
  };

  for (const [w, h] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: h > w });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1800);
    await evalIn(INJECT);
    const { results, docH } = await evalIn(SWEEP);
    const ok = results.length === 0;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(w + 'x' + h).padEnd(9)} docH=${docH}  intercepts=${results.length}`);
    for (const r of results.slice(0, 6)) console.log(`        ${r.sel} scrollY=${r.scrollY} sample=${r.sample} at ${r.px},${r.py}`);
    if (!ok) failures.push(`${w}x${h}`);
  }
} catch (err) {
  failures.push(`fatal: ${err.message}`);
} finally {
  try { cdp?.close(); } catch { /* nothing */ }
  chrome.kill('SIGKILL');
  server.close();
}

if (failures.length) {
  console.error(`\nBADGE OVERLAP FAIL: the widget badge intercepts controls at ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nBADGE OVERLAP PASS: no control is ever under the widget badge at any tested viewport or scroll.');
process.exit(0);
