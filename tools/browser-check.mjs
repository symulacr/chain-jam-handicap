#!/usr/bin/env node
/**
 * Real-browser acceptance check for the built dist/.
 *
 *   node tools/browser-check.mjs [url]
 *
 * WHY THE DEVTOOLS PROTOCOL AND NOT `chrome --dump-dom`
 *   The page runs timers (the 2.5 s standalone grace timer), so `--dump-dom` never reaches idle
 *   and hangs. This drives the DevTools Protocol directly over Node's global WebSocket, exactly
 *   as jam-candidates/tools/verify-standalone.mjs does.
 *
 * WHAT IT ASSERTS
 *   1. the page loads and the UI renders (board sockets, payline table, engine panel)
 *   2. the FIRST / SECOND pick control works (clicking SECOND flips the highlight)
 *   3. DEAL runs a round and the result SETTLES: the result line names a winner, the engine panel
 *      shows the Grundy value, the branching factor and the payout, with no `undefined`/`NaN`
 *   4. dealing AGAIN produces a NEW round (a different board)
 *
 * Exits non-zero and prints the exact settled text on any failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_UNDER_TEST = process.argv[2] ?? process.env.URL ?? 'http://127.0.0.1:8921/';
const CHROME = process.env.CHROME
  ?? [
    '/home/eya/.agent-browser/browsers/chrome-154.0.8037.57/chrome',
    '/home/eya/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  ].find((p) => fs.existsSync(p));
const PORT = Number(process.env.CDP_PORT ?? 9223);
const PROFILE = process.env.CDP_PROFILE ?? '/tmp/handicap-cdp-profile';
const SHOT = path.join(ROOT, 'docs', 'browser-round.png');

if (!CHROME) {
  console.error('no chrome binary found');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`\nBROWSER CHECK FAILED: ${msg}`); process.exit(1); };

function startChrome() {
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] }).on('error', (e) => fail(`chrome spawn: ${e.message}`));
}

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools did not come up');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message ?? ''))));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        id += 1;
        const myId = id;
        return new Promise((res, rej) => {
          pending.set(myId, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: myId, method, params }));
        });
      },
      close() { ws.close(); },
    }));
  });
}

const evalIn = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) fail(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
};

const chrome = startChrome();
let cdp;
try {
  cdp = await connect(await waitForDevtools());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors = [];
  // (console capture is best-effort; the assertions below are on rendered text)

  await cdp.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(2200);

  const before = await evalIn(cdp, `(() => ({
    title: document.title,
    sockets: document.querySelectorAll('#board .socket').length,
    pins: document.querySelectorAll('#board .socket.pin').length,
    bands: document.querySelectorAll('#bands tr').length - 1,
    host: document.getElementById('hostcell').textContent,
    wallet: document.getElementById('walletcell').textContent,
    parity: document.getElementById('paritycell').textContent,
    richtext: document.getElementById('result').innerText,
  }))()`);

  const host = String(before.host).replace(/\s+/g, ' ').trim();
  const hostOk = /standalone demo/i.test(host);
  const uiOk = before.sockets === 18 && before.bands === 6;
  console.log(`page      : ${before.title}`);
  console.log(`render    : ${before.sockets} sockets (${before.pins} pins), ${before.bands} payline bands`);
  console.log(`host      : ${host}  wallet ${before.wallet}  ::  ${before.parity}`);
  if (!uiOk) fail(`UI did not render (sockets=${before.sockets}, bands=${before.bands})`);

  // 2. the pick control
  const pickState = await evalIn(cdp, `(() => {
    document.getElementById('pickSecond').click();
    return {
      firstOn: document.getElementById('pickFirst').classList.contains('on'),
      secondOn: document.getElementById('pickSecond').classList.contains('on'),
    };
  })()`);
  console.log(`pick      : clicked SECOND -> FIRST.on=${pickState.firstOn} SECOND.on=${pickState.secondOn}`);
  if (pickState.firstOn || !pickState.secondOn) fail('the FIRST/SECOND pick control did not switch to SECOND');

  // 3. DEAL -> settle
  await evalIn(cdp, `document.getElementById('deal').click()`);
  await sleep(1600);
  const round1 = await evalIn(cdp, `(() => ({
    result: document.getElementById('result').innerText,
    engine: document.getElementById('engine').innerText,
    boardmeta: document.getElementById('boardmeta').textContent,
    source: document.getElementById('source').textContent,
    parity: document.getElementById('paritycell').textContent,
  }))()`);

  const r1 = String(round1.result).replace(/\s+/g, ' ').trim();
  const e1 = String(round1.engine).replace(/\s+/g, ' ').trim();
  const b1 = String(round1.boardmeta).replace(/\s+/g, ' ').trim();
  console.log(`\nround 1 result : ${r1}`);
  console.log(`round 1 engine : ${e1}`);
  console.log(`round 1 board  : ${b1}`);
  console.log(`round 1 source : ${String(round1.source).replace(/\s+/g, ' ').trim()}`);

  const settled = /(PAID|NO RETURN)/i.test(r1) && /WINS/i.test(r1);
  const hasGrundy = /GRUNDY/.test(e1);
  const hasBranching = /BRANCHING/.test(e1);
  const hasPayout = /PAYOUT/.test(e1);
  const dirty = /undefined|NaN/i.test(r1 + ' ' + e1 + ' ' + b1);
  if (!settled) fail(`the round did not settle; result text: "${r1}"`);
  if (!hasGrundy) fail(`no Grundy value in the engine panel: "${e1}"`);
  if (!hasBranching) fail(`no branching factor in the engine panel: "${e1}"`);
  if (!hasPayout) fail(`no payout line in the engine panel: "${e1}"`);
  if (dirty) fail('the settled text contains undefined/NaN');
  console.log(`\nassert    : settled=${settled} grundy=${hasGrundy} branching=${hasBranching} payout=${hasPayout} dirty=${dirty}`);

  // screenshot of the settled round
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`screenshot: ${path.relative(ROOT, SHOT)} (${fs.statSync(SHOT).size} B)`);
  } catch (e) { console.log(`screenshot: skipped (${e.message})`); }

  // 4. DEAL again -> a NEW round
  await sleep(120);
  await evalIn(cdp, `document.getElementById('deal').click()`);
  await sleep(1600);
  const round2 = await evalIn(cdp, `(() => ({
    result: document.getElementById('result').innerText,
    boardmeta: document.getElementById('boardmeta').textContent,
  }))()`);
  const r2 = String(round2.result).replace(/\s+/g, ' ').trim();
  const b2 = String(round2.boardmeta).replace(/\s+/g, ' ').trim();
  console.log(`\nround 2 result : ${r2}`);
  console.log(`round 2 board  : ${b2}`);

  if (!/(PAID|NO RETURN)/i.test(r2)) fail(`the second deal did not settle: "${r2}"`);
  if (b1 === b2) fail(`the second deal produced the SAME board: "${b1}"`);

  console.log(`\nBROWSER CHECK PASS  (${URL_UNDER_TEST})`);
  console.log('  page loads; UI renders; pick works; DEAL runs; round resolves with winner/Grundy/');
  console.log('  branching/payout; dealing again produced a new round.');
  if (consoleErrors.length) console.log(`  console errors: ${consoleErrors.join(' | ')}`);
  cdp.close();
  chrome.kill('SIGKILL');
  process.exit(0);
} catch (err) {
  try { cdp?.close(); } catch { /* nothing */ }
  chrome.kill('SIGKILL');
  fail(err.message);
}
