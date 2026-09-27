/**
 * HANDICAP model tests.
 *
 *   node --test tests/model.test.mjs
 *
 * Covers the harness contract (band boundaries, tiling, RTP range), the exact position maths
 * against an independently written brute-force Node-Kayles search, the payline against the
 * contract's constants, and the round sampler against the Wave-3 C1 defect shape.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BANDS, EXPECTED_RTP_BPS, SLUG, bandOf, makeRng, outcome } from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = readFileSync(path.resolve(HERE, '../contracts/HandicapGame.sol'), 'utf8');

/** word from an 18-bit board: first three bytes big-endian, rest zero. */
const wordFromBoard = (board) => '0x' + board.toString(16).padStart(6, '0') + '0'.repeat(58);
const BOARDS = 1 << 18;

// ---------------------------------------------------------------- interface contract
test('SLUG and RTP declaration', () => {
  assert.equal(SLUG, 'handicap');
  assert.ok(Number.isInteger(EXPECTED_RTP_BPS));
  assert.ok(EXPECTED_RTP_BPS >= 9300 && EXPECTED_RTP_BPS <= 9800, 'declared RTP inside 93..98%');
});

test('BANDS tile the stat space with no gap, no overlap and non-decreasing multipliers', () => {
  const bands = [...BANDS].sort((a, b) => a.min - b.min);
  let cursor = bands[0].min;
  for (const b of bands) {
    assert.equal(b.min, cursor, `gap/overlap at ${cursor}`);
    assert.ok(b.max >= b.min);
    cursor = b.max + 1;
  }
  for (let i = 1; i < bands.length; i += 1) {
    assert.ok(bands[i].mult >= bands[i - 1].mult, 'mults must not decrease');
  }
});

test('bandOf agrees with BANDS at both edges of every band', () => {
  for (const b of BANDS) {
    assert.equal(bandOf(b.min), b.mult);
    assert.equal(bandOf(b.max), b.mult);
  }
});

// ---------------------------------------------------------------- position maths
/** Independent brute-force KAYLES Grundy on an explicit row bitmask, by recursive mex.
 *  A move knocks down one pin, or two adjacent pins. No run-length DP, no shared table. */
function kaylesGrundy(mask, cols = 6) {
  const memo = new Map();
  const solve = (m) => {
    if (m === 0) return 0;
    if (memo.has(m)) return memo.get(m);
    const opts = new Set();
    for (let i = 0; i < cols; i += 1) {
      if (!((m >> i) & 1)) continue;
      opts.add(solve(m & ~(1 << i))); // one pin
      if (i + 1 < cols && ((m >> (i + 1)) & 1)) opts.add(solve(m & ~(3 << i))); // two adjacent pins
    }
    let mex = 0;
    while (opts.has(mex)) mex += 1;
    memo.set(m, mex);
    return mex;
  };
  return solve(mask);
}

test('row Grundy table equals an independently written brute-force search', () => {
  for (let pat = 0; pat < 64; pat += 1) {
    const o = outcome(wordFromBoard(pat)); // row A carries the pattern, B and C empty
    assert.equal(o.rowGrundy[0], kaylesGrundy(pat), `row pattern ${pat}`);
  }
  // the classic Kayles single-run sequence G(0..6) = 0,1,2,3,1,4,3
  assert.deepEqual([0, 0b1, 0b11, 0b111, 0b1111, 0b11111, 0b111111].map((m) => kaylesGrundy(m)),
    [0, 1, 2, 3, 1, 4, 3]);
});

test('worked examples: full row, 4-pin run, empty board, tier boundaries', () => {
  // row A = 111111 -> Kayles G(6) = 3 ; rows B, C empty -> G = 3 -> FIRST wins.
  // moves = 2*6-1 = 11, which is in the 11..13 bucket = tier 2 -> stat 10 -> 1.2325x
  const full = outcome(wordFromBoard(63));
  assert.deepEqual(full.rows, [63, 0, 0]);
  assert.deepEqual(full.rowGrundy, [3, 0, 0]);
  assert.equal(full.grundy, 3);
  assert.equal(full.firstWins, true);
  assert.equal(full.moves, 11);
  assert.equal(full.tier, 2);
  assert.equal(full.stat, 10);
  assert.equal(full.mult, 1.2325);

  // a 4-pin run: Kayles G(4) = 1, and with B and C empty that is a FIRST win
  const four = outcome(wordFromBoard(0b111100));
  assert.equal(four.rowGrundy[0], 1);
  assert.equal(four.grundy, 1);
  assert.equal(four.firstWins, true);
  assert.equal(four.mult, 1.2639);

  // a two-pin run plus a one-pin run: G(2) ^ G(1) = 2 ^ 1 = 3, and moves 3 + 1 = 4 -> tier 4
  const mini = outcome(wordFromBoard(0b11 | (1 << 5)));
  assert.deepEqual(mini.rows, [0b100011, 0, 0]);
  assert.deepEqual(mini.rowGrundy, [3, 0, 0]);
  assert.equal(mini.moves, 4);
  assert.equal(mini.tier, 4);
  assert.equal(mini.mult, 1.4068);

  // a board with no pins at all: G = 0, no legal moves, so SECOND wins
  const dead = outcome(wordFromBoard(0));
  assert.equal(dead.grundy, 0);
  assert.equal(dead.moves, 0);
  assert.equal(dead.firstWins, false);
  assert.equal(dead.mult, 0);

  // 3 xor 2 = 1 -> FIRST wins, and moves 11 + 3 = 14 -> tier 1
  const two = outcome(wordFromBoard(63 | (0b11 << 6)));
  assert.deepEqual(two.rows, [63, 3, 0]);
  assert.deepEqual(two.rowGrundy, [3, 2, 0]);
  assert.equal(two.grundy, 1);
  assert.equal(two.moves, 14);
  assert.equal(two.tier, 1);
  assert.equal(two.stat, 9);
  assert.equal(two.mult, 1.226);
});

test('the winner is exactly "the XOR of the row Grundy values is non-zero"', () => {
  for (let i = 0; i < 4000; i += 1) {
    const w = makeRng('0x' + '5a'.repeat(32), i);
    const o = outcome(w);
    const x = o.rowGrundy[0] ^ o.rowGrundy[1] ^ o.rowGrundy[2];
    assert.equal(o.grundy, x);
    assert.equal(o.firstWins, x !== 0);
    assert.equal(o.stat, (x !== 0 ? 8 : 0) + o.tier);
    assert.equal(o.mult, bandOf(o.stat));
  }
});

test('moves/tier boundaries', () => {
  const seen = new Map();
  for (let board = 0; board < BOARDS; board += 1) {
    const o = outcome(wordFromBoard(board));
    seen.set(o.moves, o.tier);
  }
  for (const [moves, tier] of seen) {
    const expected = moves >= 19 ? 0 : moves >= 14 ? 1 : moves >= 11 ? 2 : moves >= 7 ? 3 : 4;
    assert.equal(tier, expected, `moves ${moves}`);
  }
  assert.ok(seen.size >= 25, 'the branching factor takes many distinct values');
});

// ---------------------------------------------------------------- contract parity
/** Evaluate a Solidity packed-constant expression (a | b<<32 | ...) with BigInt. */
function solConst(name) {
  const m = CONTRACT.match(new RegExp(name + '\\s*=\\s*([0-9_\\s|()<>.]+);'));
  assert.ok(m, `contract constant ${name} not found`);
  const terms = m[1].replace(/_/g, '').split('|');
  let total = 0n;
  for (const term of terms) {
    const parts = term.replace(/[()]/g, '').split('<<').map((x) => x.trim());
    let v = BigInt(parts[0]);
    if (parts[1]) v <<= BigInt(parts[1]);
    total |= v;
  }
  return total;
}

test('contract price tables match model.mjs band-for-band', () => {
  const pf = solConst('PRICE_FIRST_PACKED');
  const ps = solConst('PRICE_SECOND_PACKED');
  const modelFirst = BANDS.filter((b) => b.min >= 8).map((b) => Math.round(b.mult * 10000));
  assert.equal(modelFirst.length, 5);
  const mask = 0xffffffffn;
  for (let t = 0; t < 5; t += 1) {
    assert.equal(Number((pf >> BigInt(32 * t)) & mask), modelFirst[t], `tier ${t} First price`);
    assert.ok(Number((ps >> BigInt(32 * t)) & mask) > 0, `tier ${t} Second price present`);
  }
});

test('contract carries the model table constants verbatim', () => {
  assert.ok(CONTRACT.includes(String(EXPECTED_RTP_BPS)), `RTP ${EXPECTED_RTP_BPS} in the contract`);
  assert.ok(CONTRACT.includes(String(solConst('ROW_G_PACKED'))), 'row Grundy table verbatim');
  assert.ok(CONTRACT.includes(String(solConst('ROW_MOVES_PACKED'))), 'row move table verbatim');
  assert.ok(CONTRACT.includes(String(80492)), 'max price in the contract');
});

// ---------------------------------------------------------------- sampler (C1)
test('makeRng returns distinct 32-byte words across magnitudes up to 2^52', () => {
  const seed = '0x' + 'c0ffee'.repeat(10) + 'c0ff';
  const starts = [0, 1, 1000, 1_000_000, 1_000_000_000, 1_000_000_000_000, 4_503_599_627_370_496];
  for (const start of starts) {
    const seen = new Set();
    for (let r = start; r < start + 20000; r += 1) {
      const w = makeRng(seed, r);
      assert.match(w, /^0x[0-9a-f]{64}$/);
      assert.ok(!seen.has(w), `collision at round ${r}`);
      seen.add(w);
    }
  }
});

test('makeRng is a pure counter function with no float drift', () => {
  const seed = '0x' + '11'.repeat(32);
  assert.equal(makeRng(seed, 4503599627370496), makeRng(seed, 4503599627370496));
  assert.notEqual(makeRng(seed, 4503599627370496), makeRng(seed, 4503599627370497));
  // the C1 shape (seed0 + round * K) would alias here; ours must not
  const lo = makeRng(seed, 4503599627370495);
  assert.notEqual(lo, makeRng(seed, 4503599627370496));
});

// ---------------------------------------------------------------- RTP
test('exact RTP across the whole 2^18 board space matches the declaration', () => {
  let sum = 0;
  for (let board = 0; board < BOARDS; board += 1) sum += bandOf(outcome(wordFromBoard(board)).stat);
  const bps = Math.round((sum / BOARDS) * 10000);
  assert.ok(Math.abs(bps - EXPECTED_RTP_BPS) <= 1, `exact ${bps} bps vs declared ${EXPECTED_RTP_BPS}`);
});

test('both sides of the book return the same RTP (within 1 bp)', () => {
  let sumFirst = 0;
  let sumSecond = 0;
  for (let board = 0; board < BOARDS; board += 1) {
    const o = outcome(wordFromBoard(board));
    sumFirst += o.firstWins ? o.priceFirstBps : 0;
    sumSecond += o.firstWins ? 0 : o.priceSecondBps;
  }
  const first = Math.round(sumFirst / BOARDS);
  const second = Math.round(sumSecond / BOARDS);
  assert.ok(Math.abs(first - EXPECTED_RTP_BPS) <= 1, `first side ${first}`);
  assert.ok(Math.abs(second - EXPECTED_RTP_BPS) <= 1, `second side ${second}`);
  assert.ok(Math.abs(first - second) <= 1, `the two sides differ by ${Math.abs(first - second)} bps`);
});
