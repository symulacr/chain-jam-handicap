/**
 * HANDICAP — front-end affordance regressions (hermetic; no browser, no network).
 *
 *   node --test tests/ui.test.mjs          (part of `npm test`)
 *
 * These pin the exact source decisions that fix the Wave-3 findings, so a later edit cannot
 * silently re-introduce them without a failing test:
 *
 *   D2  a disabled control must be visually inert (opacity/filter/cursor), and BET/WAGER must
 *       carry a title + aria-disabled explaining why they are disabled.
 *   D3  the standalone page must SAY the wager is a demo (visible "no wager" labelling).
 *   D4  a phone-width media query must reorder the primary flow (the bet slip) above the fold.
 *   D6  the bet bar must out-stack the fixed Chain Jam widget badge (z-index 2147483000).
 *
 * The authoritative proof for D6 is the real viewport x scroll sweep in `npm run test:browser`;
 * this file only pins the source invariant that makes it hold.
 *
 * D8/D9 below are a different kind of test: they LOAD src/app.js and drive it against a DOM stub
 * and a fake host bridge. A source regex cannot see what the page hands `openSession` nor what it
 * does with an unreadable settlement, which is how both defects survived this file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionPhase } from '../src/sdk/guest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
const APP = readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');

/** Return the body of a CSS rule whose selector appears verbatim at the start of a line. */
function ruleBody(selector) {
  const idx = CSS.indexOf(selector + ' {');
  assert.ok(idx >= 0, `styles.css has no rule "${selector} {"`);
  const open = CSS.indexOf('{', idx);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

test('D2: disabled buttons are visually inert (opacity, filter and cursor differ)', () => {
  const body = ruleBody('button[disabled]');
  const opacity = Number((body.match(/opacity:\s*([\d.]+)/) ?? [])[1]);
  assert.ok(Number.isFinite(opacity) && opacity < 1, `button[disabled] must reduce opacity, got ${body}`);
  assert.match(body, /filter:\s*grayscale/, 'button[disabled] must desaturate via filter');
  assert.match(body, /cursor:\s*not-allowed/, 'button[disabled] must set cursor: not-allowed');
  // The .go gradient (BET/DEAL) must also stop looking live when disabled.
  const goDisabled = ruleBody('button.go[disabled]');
  assert.match(goDisabled, /background:/, 'button.go[disabled] must override the live green gradient');
});

test('D2: BET and WAGER explain why they are disabled (title + aria-disabled)', () => {
  const bet = HTML.match(/<button class="go" id="bet"[^>]*>/)?.[0] ?? '';
  const wager = HTML.match(/<input[^>]*id="wager"[^>]*>/)?.[0] ?? '';
  assert.match(bet, /title="[^"]*Chain\.wtf host/, 'BET must carry a title naming the missing host');
  assert.match(bet, /aria-disabled="true"/, 'BET must carry aria-disabled="true"');
  assert.match(wager, /title="[^"]*no wager/i, 'WAGER must carry a title saying no wager is placed');
  assert.match(wager, /aria-disabled="true"/, 'WAGER must carry aria-disabled="true"');
});

test('D3: the standalone slip says the wager is a demo (visible labelling)', () => {
  // The slip caption element must exist and be addressable, so app.js can relabel it.
  assert.match(HTML, /<div class="cap" id="cap">/, 'the slip caption must carry id="cap"');
  // enterStandalone must set a visible "demo, no wager" caption.
  assert.match(APP, /enterStandalone[\s\S]*?\$\('cap'\)\.textContent = '[^']*demo, no wager/, 'enterStandalone must set the demo caption');
  // The plain (host) path must reset it.
  assert.match(APP, /\$\('cap'\)\.textContent = 'Back a side before the deal';/, 'the host path must reset the caption');
});

test('D4: a phone-width media query flattens and reorders the primary flow', () => {
  const mq = CSS.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(mq, 'styles.css must carry a max-width: 640px media query');
  const body = mq[1];
  assert.match(body, /\.col-right\s*\{\s*display:\s*contents/, 'the right column must flatten so its children can be reordered');
  assert.match(body, /\.slip\s*\{\s*order:\s*1\b/, 'the bet slip must be ordered ahead of the engine/deep panels');
  // Desktop must not be touched: the media query is the only reorder. `\border` (not `order`) so
  // the plain `.slip { ... border: ... }` rule is not mistaken for an order declaration.
  assert.doesNotMatch(CSS.replace(mq[0], ''), /\.slip\s*\{[^}]*\border\s*:/, 'no unconditional .slip order rule is allowed');
});

test('D6: the bet bar out-stacks the fixed widget badge', () => {
  // The widget renders its badge at z-index 2147483000 (see research/wave1-browser-root-causes.md D6).
  const BADGE_Z = 2147483000;
  const body = ruleBody('.slip .buttons');
  const z = Number((body.match(/z-index:\s*(\d+)/) ?? [])[1]);
  assert.ok(z > BADGE_Z, `.slip .buttons z-index ${z} must exceed the badge's ${BADGE_Z}`);
  assert.match(body, /position:\s*relative/, '.slip .buttons must be positioned for z-index to apply');
});

test('D6: the widget script is still shipped (submission requirement)', () => {
  assert.match(HTML, /<script async src="https:\/\/jam\.chain\.wtf\/widget\.js"><\/script>/);
});

test('Wave 4: the BOARD/ENGINE/RULES tabs are functional in-page links, not dead chrome', () => {
  // Each tab must be an anchor whose fragment resolves to a real panel id (so a click has an
  // observable effect: the active highlight moves, the URL hash changes and :target outlines
  // the section). Previously they were `div`s with no handler and did nothing.
  const tabs = [...HTML.matchAll(/<a class="tab(?: on)?" href="#([^"]+)">([A-Z]+)<\/a>/g)];
  assert.equal(tabs.length, 3, 'three tab anchors expected');
  const targets = new Set();
  for (const [, target, label] of tabs) {
    assert.match(HTML, new RegExp(`id="${target}"`), `tab ${label} must point at an existing #${target}`);
    targets.add(target);
  }
  assert.equal(targets.size, 3, 'each tab must point at a distinct panel');
  assert.match(CSS, /\.cab:target\s*\{/, 'the targeted section must be styled so the jump is visible');
  assert.match(APP, /\.tabstrip \.tab[\s\S]*?addEventListener\('click'/, 'the tab strip must wire the active highlight');
});

// ------------------------------------------------------------------ real-module harness (D8, D9)
/**
 * src/app.js is a browser ESM with no exports and no test seam, so the harness supplies the two
 * things it expects from its environment — a `document`/`window` and a host API — and then loads
 * the real module. Every line of app.js under test (the wager parse, the limit clamp, the
 * openSession call, the settlement decode, the note line) is the shipped code; none of it is
 * copied here.
 *
 * Bridge seam: app.js takes its host object from `connectGameToHost` in src/sdk/guest.mjs. The
 * loader hook below replaces ONLY that export with a stub returning the fake host, and
 * re-exports the real module untouched for everything else, so `computeMaxWager` (which decides
 * the limit the page clamps against) and `SessionPhase` are the genuine SDK values.
 */
const APP_URL = new URL('../src/app.js', import.meta.url).href;
const GUEST_URL = new URL('../src/sdk/guest.mjs', import.meta.url).href;
const GUEST_STUB_URL = 'stub:handicap-guest-sdk';
const GUEST_STUB_SOURCE = [
  `export * from ${JSON.stringify(GUEST_URL)};`,
  'export function connectGameToHost(methods) {',
  '  return globalThis.__handicapHostBridge(methods);',
  '}',
].join('\n');

if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './sdk/guest.mjs' && context.parentURL && context.parentURL.startsWith(APP_URL)) {
        return { url: GUEST_STUB_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === GUEST_STUB_URL) return { format: 'module', source: GUEST_STUB_SOURCE, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
} else {
  // registerHooks is in-thread and synchronous (Node >= 22.15); the threaded register() is the
  // same two hooks for the older range package.json's ">=20" allows.
  const threaded = `export function resolve(s, c, n) {
  if (s === './sdk/guest.mjs' && c.parentURL && c.parentURL.startsWith(${JSON.stringify(APP_URL)})) return { url: ${JSON.stringify(GUEST_STUB_URL)}, shortCircuit: true };
  return n(s, c);
}
export function load(u, c, n) {
  if (u === ${JSON.stringify(GUEST_STUB_URL)}) return { format: 'module', source: ${JSON.stringify(GUEST_STUB_SOURCE)}, shortCircuit: true };
  return n(u, c);
}`;
  Module.register('data:text/javascript,' + encodeURIComponent(threaded), import.meta.url);
}

const SESSION_KEY = 'key-1';
const SESSION_ID = 'sess-1';
// The host publishes this risk limit in base units; at 18 decimals it is exactly 0.07 CHIPS, so a
// wager of "0.07" is the largest the page must accept and "0.08" the smallest it must refuse.
const LIMIT_BASE = 7n * 10n ** 16n;

function makeElement(id) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id, className: '', textContent: '', innerHTML: '', value: '', title: '', disabled: false,
    style: {}, attrs: new Map(), children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) (classes.has(c) ? classes.delete(c) : classes.add(c)); else if (on) classes.add(c); else classes.delete(c); },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    setAttribute(k, v) { this.attrs.set(k, v); },
    removeAttribute(k) { this.attrs.delete(k); },
    appendChild(child) { this.children.push(child); return child; },
    fire(type) { for (const fn of listeners.get(type) ?? []) fn(); },
  };
}

let appLoads = 0;
async function loadApp() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  globalThis.document = {
    getElementById: byId,
    createElement: (tag) => makeElement(tag),
    querySelectorAll: () => [],
    body: makeElement('body'),
    documentElement: makeElement('html'),
    referrer: '',
  };
  globalThis.window = { origin: 'http://localhost', addEventListener() {}, removeEventListener() {} };
  const host = { opened: [], revealed: [], deliver: null };
  globalThis.__handicapHostBridge = (methods) => {
    host.deliver = methods.setState;
    return {
      promise: Promise.resolve({
        openSession(req) {
          host.opened.push(req);
          return Promise.resolve({ sessionKey: SESSION_KEY, sessionId: SESSION_ID });
        },
        revealOutcome(req) { host.revealed.push(req); return Promise.resolve(); },
      }),
      destroy() {},
    };
  };
  appLoads += 1;
  await import(APP_URL + '?load=' + appLoads);   // fresh module instance: no state carried between loads
  return { el: byId, host, push: (snap) => host.deliver(snap) };
}

const readySnapshot = (sessions = []) => ({
  wallet: { status: 'ready' },
  token: { symbol: 'CHIPS', decimals: 18 },
  casino: { maxBetAmount: LIMIT_BASE, maxAllowedReservedProfit: 10n ** 24n },
  sessions: { items: sessions },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('D8: BET hands the host the exact quantity the limit check accepted', async () => {
  const refused = await loadApp();
  await refused.push(readySnapshot());
  refused.el('wager').value = '0.08';
  refused.el('bet').fire('click');
  await tick();
  assert.equal(refused.host.opened.length, 0, 'a wager over the published host limit must not open a session');
  assert.match(refused.el('note').textContent, /limit/, 'the refusal must say why');

  const accepted = await loadApp();
  await accepted.push(readySnapshot());
  accepted.el('wager').value = '0.07';   // exactly the published limit, so the clamp must let it through
  accepted.el('bet').fire('click');
  await tick();
  assert.equal(accepted.host.opened.length, 1, 'BET must open exactly one session');
  // Expected value is the host's own published limit, not a literal taken from app.js: the page
  // told the player 0.07 was stakeable at the limit, so 0.07 worth of escrow is what must be
  // asked for. The pre-fix page sent the raw "0.07" and escrowed 7e14 instead of 7e16.
  assert.equal(accepted.host.opened[0].wager, LIMIT_BASE.toString(),
    'the wager sent to the host must be the clamped base-unit amount, not the raw whole-token text');
  assert.equal(accepted.host.opened[0].gameData, '0x01', 'FIRST is committed as gameData 0x01');

  // Finish the round on a readable settlement so the app clears its 90 s watchdog (an armed
  // watchdog is a live handle that would hold this test process open) and so the normal path
  // is checked to still reveal.
  const hexWord = (v) => v.toString(16).padStart(64, '0');
  await accepted.push(readySnapshot([{
    sessionKey: SESSION_KEY, sessionId: SESSION_ID, isSettled: true, phase: SessionPhase.SETTLED,
    stake: LIMIT_BASE.toString(),
    raw: { gameState: '0x' + hexWord(1n) + hexWord(0n) + hexWord(0n) + hexWord(0n) + hexWord(1n) + hexWord(0n) },
  }]));
  await tick();
  assert.equal(accepted.host.revealed.length, 1, 'a readable settlement must still reveal to the host');
});

test('D9: a settled round whose gameState cannot be read still resolves on screen', async () => {
  const broken = [
    ['too short to hold six words', '0x' + '0'.repeat(63)],
    ['present but not hex', '0x' + 'z'.repeat(64) + '0'.repeat(320)],
  ];
  for (const [label, gameState] of broken) {
    const app = await loadApp();
    await app.push(readySnapshot());
    app.el('wager').value = '0.07';
    app.el('bet').fire('click');
    await tick();
    assert.equal(app.host.opened.length, 1, `${label}: BET must open a session`);

    const waiting = app.el('note').textContent;
    assert.match(waiting, new RegExp(SESSION_KEY), `${label}: the open note must name the session`);
    let threw = null;
    try {
      // setState is async in app.js, so the delivery is awaited: a throw inside applySnapshot
      // surfaces here as a rejection, which the harness would otherwise never observe.
      await app.push(readySnapshot([{
        sessionKey: SESSION_KEY, sessionId: SESSION_ID, isSettled: true,
        phase: SessionPhase.SETTLED, stake: LIMIT_BASE.toString(), raw: { gameState },
      }]));
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `${label}: an unreadable settlement must not throw out of the snapshot handler (${threw})`);
    const after = app.el('note').textContent;
    assert.notEqual(after, waiting, `${label}: the round must not vanish without a word`);
    assert.match(after, new RegExp(SESSION_ID), `${label}: the message must name the settled session`);
    assert.match(after, /could not be read/, `${label}: the message must state the failure`);
    // The round is over one way or the other, so the slip must be usable again.
    await app.push(readySnapshot());
    assert.equal(app.el('bet').disabled, false, `${label}: BET must be re-enabled after the failure`);
  }
});
