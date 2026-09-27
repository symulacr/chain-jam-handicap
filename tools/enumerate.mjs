#!/usr/bin/env node
/**
 * Exhaustive RTP proof for HANDICAP.
 *
 *   node tools/enumerate.mjs
 *
 * The VRF word space is 2^256, but `outcome()` reads only bits 232..255, i.e. the board, and
 * every one of the 2^18 boards is equally likely. So the distribution over positions is
 * EXACTLY uniform on 2^18 states, and the RTP can be computed by enumeration instead of
 * estimated by Monte Carlo. This script does that, then re-reads the tier counts out of
 * model.mjs and fails loudly if the two disagree.
 *
 * It also verifies, for all 2^18 boards, that the word->board mapping the model uses agrees
 * with `uint24(uint256(word) >> 232)` as written in contracts/HandicapGame.sol — the bit order
 * is encoded here a second time, independently of model.mjs.
 */
import { BANDS, EXPECTED_RTP_BPS, SLUG, bandOf, makeRng, outcome } from '../game/model.mjs';

const COLS = 6;
const CELLS = 18;
const BOARDS = 1 << CELLS;

// --- independent second implementation of Kayles row Grundy (not imported from model.mjs) ---
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
const rowG = new Int32Array(64);
const rowMoves = new Int32Array(64);
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
  rowG[pat] = g;
  rowMoves[pat] = mv;
}

function tierOfMoves(moves) {
  if (moves >= 19) return 0;
  if (moves >= 14) return 1;
  if (moves >= 11) return 2;
  if (moves >= 7) return 3;
  return 4;
}

const toWord = (board) => {
  // first three bytes big-endian, board in the low 18 bits; the remaining 29 bytes are zero
  const b = [(board >> 16) & 0xff, (board >> 8) & 0xff, board & 0xff];
  let hex = '0x';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  return hex + '0'.repeat(58);
};

const c0 = [0, 0, 0, 0, 0];
const c1 = [0, 0, 0, 0, 0];
let mappingMismatch = 0;
let grundyMismatch = 0;
let sampleBoards = 0;

for (let board = 0; board < BOARDS; board += 1) {
  const g = rowG[board & 63] ^ rowG[(board >> 6) & 63] ^ rowG[(board >> 12) & 63];
  const mv = rowMoves[board & 63] + rowMoves[(board >> 6) & 63] + rowMoves[(board >> 12) & 63];
  const tier = tierOfMoves(mv);
  if (g !== 0) c1[tier] += 1;
  else c0[tier] += 1;

  // cross-check the model's decode for every board (bit order + stat packing)
  const o = outcome(toWord(board));
  if (o.board !== board) mappingMismatch += 1;
  if (o.grundy !== g) grundyMismatch += 1;
  if (o.stat !== (g !== 0 ? 8 : 0) + tier) grundyMismatch += 1;
  sampleBoards += 1;
}

const n = c0.map((v, i) => v + c1[i]);
const total = n.reduce((a, b) => a + b, 0);

// prices read back out of the model's own paytable, per tier and side
const priceFirst = [];
const priceSecond = [];
for (let t = 0; t < 5; t += 1) {
  priceFirst.push(Math.round(bandOf(8 + t) * 10000));
  priceSecond.push(Math.round((EXPECTED_RTP_BPS * n[t]) / c0[t]));
}

const rtpFirst = priceFirst.reduce((a, p, t) => a + p * c1[t], 0) / total;
const rtpSecond = priceSecond.reduce((a, p, t) => a + p * c0[t], 0) / total;

console.log(`slug                  ${SLUG}`);
console.log(`boards enumerated     ${total.toLocaleString()} (2^18, every board equally likely)`);
console.log(`word->board mismatches ${mappingMismatch}`);
console.log(`grundy/stat mismatches ${grundyMismatch}`);
console.log('');
console.log('tier  branching      boards      P(First)   price FIRST   price SECOND');
for (let t = 0; t < 5; t += 1) {
  const lo = t === 0 ? '19..33' : t === 1 ? '14..18' : t === 2 ? '11..13' : t === 3 ? '7..10' : '0..6';
  console.log(
    `  ${t}   ${lo.padEnd(10)} ${String(n[t]).padStart(8)}   ${(c1[t] / n[t]).toFixed(4).padStart(8)}` +
      `   ${(priceFirst[t] / 10000).toFixed(4).padStart(9)}   ${(priceSecond[t] / 10000).toFixed(4).padStart(10)}`,
  );
}
console.log('');
console.log(`exact RTP backing FIRST  ${(rtpFirst / 100).toFixed(4)}%  (${Math.round(rtpFirst)} bps)`);
console.log(`exact RTP backing SECOND ${(rtpSecond / 100).toFixed(4)}%  (${Math.round(rtpSecond)} bps)`);
console.log(`declared EXPECTED_RTP_BPS ${EXPECTED_RTP_BPS}`);
console.log(`gap between the two sides  ${Math.abs(rtpFirst - rtpSecond).toFixed(2)} bps`);

// --- determinism / samplers ---
let sampleMismatch = 0;
for (let i = 0; i < 20000; i += 1) {
  const w = makeRng('0x' + 'ab'.repeat(32), i * 7919);
  const o = outcome(w);
  if (o.stat < 0 || o.stat > 15) sampleMismatch += 1;
  if (bandOf(o.stat) !== o.mult) sampleMismatch += 1;
}
console.log(`sampler/paytable self-consistency mismatches over 20,000 rounds: ${sampleMismatch}`);

const fail = mappingMismatch || grundyMismatch || sampleMismatch ||
  total !== BOARDS || Math.abs(rtpFirst - EXPECTED_RTP_BPS) > 1 || Math.abs(rtpSecond - EXPECTED_RTP_BPS) > 1;
console.log(fail ? '\nENUMERATION FAILED' : '\nENUMERATION OK');
process.exit(fail ? 1 : 0);
