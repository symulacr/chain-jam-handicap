/**
 * HANDICAP — contract-level checks that need no chain.
 *
 *   node --test tests/contract.test.mjs      (or: npm test, which runs all of tests/)
 *
 * These assert the SHIPPED Solidity source, not a deployed instance: interface coverage, the
 * no-constructor / pure-handler discipline, reserve-versus-payout consistency, the packed tables,
 * and the committed-state read-back (finding S2). They cannot prove runtime behaviour — no EVM is
 * run here — and the numeric model-side parity checks live in `model.test.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED_RTP_BPS, outcome } from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = readFileSync(path.resolve(HERE, '../contracts/HandicapGame.sol'), 'utf8');
const IFACE = readFileSync(path.resolve(HERE, '../contracts/ICasinoGameV2.sol'), 'utf8');

/** Evaluate a Solidity packed-constant expression (`a | b<<32 | ...`) with BigInt. */
function solConst(name, src = GAME) {
  const m = src.match(new RegExp(name + '\\s*=\\s*([0-9_\\s|()<>.]+);'));
  assert.ok(m, `constant ${name} not found`);
  let total = 0n;
  for (const term of m[1].replace(/_/g, '').split('|')) {
    const parts = term.replace(/[()]/g, '').split('<<').map((x) => x.trim());
    let v = BigInt(parts[0]);
    if (parts[1]) v <<= BigInt(parts[1]);
    total |= v;
  }
  return total;
}

test('contract is MIT and pinned to the required compiler line', () => {
  assert.match(GAME, /SPDX-License-Identifier:\s*MIT/);
  assert.match(GAME, /pragma solidity \^0\.8\.30;/);
});

test('contract implements the ICasinoGameV2 surface', () => {
  assert.match(GAME, /contract HandicapGame is ICasinoGameV2/);
  for (const fn of ['quoteCaps', 'quoteRiskParams', 'onSessionStart', 'onPlayerAction', 'onRandomness', 'quoteForfeitPayout']) {
    assert.ok(GAME.includes(`function ${fn}(`), `implementation missing ${fn}`);
    assert.ok(IFACE.includes(`function ${fn}(`), `interface missing ${fn}`);
  }
});

test('interface declares the session enum and the context/step shapes', () => {
  for (const s of ['enum SessionPhase', 'struct SessionContext', 'struct StepResult', 'interface ICasinoGameV2']) {
    assert.ok(IFACE.includes(s), `interface missing ${s}`);
  }
});

test('there is no constructor and every handler is pure or view', () => {
  assert.ok(!/constructor\s*\(/.test(GAME), 'the contract must have no constructor');
  for (const fn of ['onSessionStart', 'onPlayerAction', 'onRandomness', 'quoteForfeitPayout', 'quoteCaps', 'quoteRiskParams']) {
    assert.match(GAME, new RegExp(`function ${fn}\\([\\s\\S]{0,400}?\\b(pure|view)\\b`), `${fn} should be pure/view`);
  }
});

test('onPlayerAction reverts (the manifest advertises submitAction: false)', () => {
  assert.match(GAME, /revert HandicapGame__NoPlayerAction\(\)/);
});

test('quoteForfeitPayout returns 0 (nothing is cashable mid-round)', () => {
  const m = GAME.match(/function quoteForfeitPayout\(SessionContext calldata\)[\s\S]*?\}/);
  assert.ok(m, 'quoteForfeitPayout not found');
  assert.match(m[0], /return 0;/);
});

test('reserve discipline: start commits the worst case, settle releases nothing', () => {
  const start = GAME.match(/function onSessionStart\([\s\S]*?\n  \}/);
  const settle = GAME.match(/function onRandomness\([\s\S]*?\n  \}/);
  assert.ok(start && settle, 'handlers not found');
  assert.match(start[0], /reservedProfitDelta = int256\(\(ctx\.escrowedStake \* MAX_PRICE_BPS\) \/ BPS - ctx\.escrowedStake\)/);
  assert.match(settle[0], /reservedProfitDelta = 0;/);
  assert.match(settle[0], /escrowDelta = 0;/);
});

test('MAX_PRICE_BPS equals the largest price field on either side of the book', () => {
  const max = BigInt(GAME.match(/MAX_PRICE_BPS = ([0-9]+);/)[1]);
  const pf = solConst('PRICE_FIRST_PACKED');
  const ps = solConst('PRICE_SECOND_PACKED');
  const mask = 0xffffffffn;
  let top = 0n;
  for (let t = 0; t < 5; t += 1) {
    for (const field of [(pf >> BigInt(32 * t)) & mask, (ps >> BigInt(32 * t)) & mask]) {
      if (field > top) top = field;
    }
  }
  assert.equal(max, top, `MAX_PRICE_BPS ${max} vs largest field ${top}`);
});

test('payout is the single floor-divided source of truth and the RTP constant is present', () => {
  assert.match(GAME, /function _payout\(uint256 wager, uint256 priceBps\)[\s\S]*?return \(wager \* priceBps\) \/ BPS;/);
  assert.ok(GAME.includes(String(EXPECTED_RTP_BPS)), `RTP ${EXPECTED_RTP_BPS} must appear in the contract`);
});

test('the committed side is read back from gameState (finding S2 fixed)', () => {
  assert.match(GAME, /function _committedPick\(SessionContext calldata ctx\)/);
  assert.match(GAME, /bytes calldata gs = ctx\.gameState;/);
  assert.match(GAME, /uint8 pick = _committedPick\(ctx\);/);
});

test('the row tables in the contract are the model tables', () => {
  const COLS = 6;
  const G = [0];
  for (let L = 1; L <= COLS; L += 1) {
    const seen = new Set();
    for (let i = 0; i < L; i += 1) {
      seen.add(G[i] ^ G[L - i - 1]);
      if (L - i - 2 >= 0) seen.add(G[i] ^ G[L - i - 2]);
    }
    let m = 0;
    while (seen.has(m)) m += 1;
    G[L] = m;
  }
  let gPack = 0n;
  let mPack = 0n;
  for (let pat = 0; pat < 64; pat += 1) {
    let g = 0;
    let mv = 0;
    let i = 0;
    while (i < COLS) {
      if ((pat >> i) & 1) {
        let L = 0;
        while (i + L < COLS && ((pat >> (i + L)) & 1)) L += 1;
        g ^= G[L];
        mv += 2 * L - 1;
        i += L;
      } else i += 1;
    }
    gPack |= BigInt(g) << BigInt(4 * pat);
    mPack |= BigInt(mv) << BigInt(4 * pat);
  }
  assert.ok(GAME.includes(String(gPack)), 'ROW_G_PACKED does not match the model row table');
  assert.ok(GAME.includes(String(mPack)), 'ROW_MOVES_PACKED does not match the model move table');
});

test('quoteRiskParams quotes the side named in gameData, per the documented body-variance formula', () => {
  // SLOTS_RISK_AND_RESERVES.md invariants 3 & 4: quoteRiskParams must decode gameData the same way
  // onSessionStart does, and bodyVarianceScaled must exclude EXACTLY the tier whose probability it
  // returns as probabilityWad (the highest-multiplier winning tier for that side).
  assert.match(GAME, /function quoteRiskParams\(\s*uint256 wager,\s*bytes calldata gameData\s*\)/);
  assert.match(GAME, /uint8 pick = _pick\(gameData\);/);
  assert.ok(!GAME.includes('116619075000000000'), 'the old side-blind body variance must be gone');

  // Independent enumeration of all 2^18 boards through the MODEL, then
  //   sigma_body^2 = sum_{k!=top} p_k M_k^2 - (sum_{k!=top} p_k M_k)^2,  top = highest multiplier.
  const N = 1 << 18;
  const c1 = [0, 0, 0, 0, 0];
  const c0 = [0, 0, 0, 0, 0];
  const pf = [0, 0, 0, 0, 0];
  const ps = [0, 0, 0, 0, 0];
  for (let b = 0; b < N; b += 1) {
    const word = '0x' + b.toString(16).padStart(6, '0') + '0'.repeat(58);
    const o = outcome(word);
    if (o.firstWins) c1[o.tier] += 1; else c0[o.tier] += 1;
    pf[o.tier] = o.priceFirstBps;
    ps[o.tier] = o.priceSecondBps;
  }
  const NB = BigInt(N);
  const topTier = (prices) => prices.indexOf(Math.max(...prices));
  const pTopWad = (counts, prices) => (BigInt(counts[topTier(prices)]) * 10n ** 18n) / NB;
  const bodyVar = (counts, prices) => {
    const top = topTier(prices);
    let A = 0n;
    let B = 0n;
    for (let t = 0; t < 5; t += 1) {
      if (t === top) continue;
      const c = BigInt(counts[t]);
      const p = BigInt(prices[t]);
      A += c * p * p;
      B += c * p;
    }
    const num = 10000000000n * (A * NB - B * B); // (1e10 / N^2) * (sum c p^2 - (sum c p)^2 / N)
    const den = NB * NB;
    return (num + den / 2n) / den;
  };

  assert.equal(solConst('P_TOP_FIRST_WAD'), pTopWad(c1, pf), 'P_TOP_FIRST_WAD must be P(top FIRST tier)');
  assert.equal(solConst('P_TOP_SECOND_WAD'), pTopWad(c0, ps), 'P_TOP_SECOND_WAD must be P(top SECOND tier)');
  assert.equal(solConst('BODY_VAR_FIRST'), bodyVar(c1, pf), 'BODY_VAR_FIRST must be the documented body variance for FIRST');
  assert.equal(solConst('BODY_VAR_SECOND'), bodyVar(c0, ps), 'BODY_VAR_SECOND must be the documented body variance for SECOND');
  assert.notEqual(solConst('BODY_VAR_FIRST'), solConst('BODY_VAR_SECOND'), 'the two sides must not share one body variance');
});
