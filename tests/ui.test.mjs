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
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
