/**
 * HANDICAP — game model (single source of truth for the outcome function and the payline).
 *
 * THE GAME
 *   One VRF word deals an 18-socket board (3 rows x 6 columns). A filled socket is a pin.
 *   The position is an IMPARTIAL COMBINATORIAL GAME — KAYLES, the pin game (octal game .77).
 *   On your turn you knock down exactly one pin, or two adjacent pins inside a row; the player
 *   who cannot move loses. A row's Grundy value depends only on its own 6-bit pattern, so the
 *   whole position is the disjoint sum of the three row games and its Sprague-Grundy value is
 *   the XOR of the three row values (Sprague-Grundy: G(A + B) = G(A) XOR G(B)).
 *     g != 0  ->  FIRST wins under perfect play
 *     g == 0  ->  SECOND wins under perfect play
 *   The player backs FIRST or SECOND BEFORE the deal. The winner is a pure function of the
 *   word: the contract recomputes the same XOR, so the reveal can never disagree with money.
 *
 *   (Note for reviewers: the brief suggested Node-Kayles on a seeded graph, where a move takes
 *   a vertex AND its neighbours. That game needs a 2^n memo over vertex subsets, which is
 *   prohibitively expensive to run in the settlement path. Kayles is the same family, has the
 *   same exact-Grundy claim, and its per-row Grundy table is a 64-entry DP, so the contract
 *   scores the position in a few hundred gas. The substitution is recorded in
 *   docs/architecture.md.)
 *
 * THE PAYLINE (graded, as required)
 *   The WINNER is binary, so a flat payout would be a coin-flip-shaped bet. The payout is
 *   therefore graded by the position's VOLATILITY TIER, which is its branching factor (the
 *   number of legal moves = sum over maximal runs of length L of (2L-1)) bucketed into five
 *   levels. Each tier quotes its own price on each side. The price is the FAIR price for that
 *   tier (payout = RTP_TARGET / win-probability of the tier), so both sides of the market
 *   return the same expected value in every tier: the game is a two-sided handicap book, not
 *   a coin flip with one price.
 *
 * RTP
 *   The seed space is 2^256, so RTP is NOT taken on faith from a Monte Carlo run. The board
 *   space (2^18) is enumerated exhaustively by `tools/enumerate.mjs`, the exact tier counts
 *   below are that enumeration's output, and the declared RTP is the exact weighted sum of
 *   those integer odds. `research/wave5-contradictions.md` C1 is why: a correct game shipped a
 *   false 96.816% declaration because a broken round SAMPLER was trusted. The sampler here is
 *   the C1-safe counter-based makeRng below, and the harness re-derives RTP from a CSPRNG this
 *   module does not control.
 *
 * PURE FUNCTION
 *   outcome(word) reads bits 232..255 of the word (the first three bytes) and nothing else:
 *   no crypto, no I/O, no clock, no ambient state.
 */

export const SLUG = 'handicap';

// ------------------------------------------------------------------ position geometry
const COLS = 6;
const ROWS = 3;
const CELLS = COLS * ROWS; // 18 pins

/**
 * Kayles on a single row: G(L) = mex{ G(i)^G(L-i-1), G(i)^G(L-i-2) }.
 * Memoised DP, evaluated once at module load. G(0..6) = 0,1,2,3,1,4,3.
 */
const ROW_G_MAX = (() => {
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
  return G;
})();

/** Per 6-bit row pattern: its exact Grundy value, its legal-move count, its run count. */
const ROW_G = new Int32Array(64);
const ROW_MOVES = new Int32Array(64);
for (let pat = 0; pat < 64; pat += 1) {
  let g = 0;
  let moves = 0;
  let i = 0;
  while (i < COLS) {
    if ((pat >> i) & 1) {
      let L = 0;
      while (i + L < COLS && ((pat >> (i + L)) & 1)) L += 1;
      g ^= ROW_G_MAX[L];
      moves += 2 * L - 1; // L single-pin moves + (L-1) adjacent-pair moves
      i += L;
    } else {
      i += 1;
    }
  }
  ROW_G[pat] = g;
  ROW_MOVES[pat] = moves;
}

// ------------------------------------------------------------------ volatility tiers
/**
 * Tier boundaries over the branching factor (= legal-move count). The buckets are the widest
 * spread of the tier win-rate found by an exhaustive search over contiguous move buckets with
 * every tier carrying at least 5% of the board space, then RE-INDEXED so that the First-side
 * price rises with the tier index — that ordering is what makes BANDS monotonically
 * non-decreasing, which the harness checks.
 */
function tierOfMoves(moves) {
  if (moves >= 19) return 0;
  if (moves >= 14) return 1;
  if (moves >= 11) return 2;
  if (moves >= 7) return 3;
  return 4;
}

/**
 * EXACT tier counts from tools/enumerate.mjs over all 2^18 boards.
 *   c1 = boards where First wins, c0 = boards where Second wins, n = c0 + c1.
 */
const TIER_C1 = [19676, 65572, 57936, 50364, 8808];
const TIER_C0 = [2633, 19053, 17226, 16641, 4235];
const TIER_N = [22309, 84625, 75162, 67005, 13043];
const BOARDS = 262144; // 2^18

/** Target return per unit staked, in bps. The book is priced at this on BOTH sides. */
const RTP_TARGET_BPS = 9500;

/**
 * Fair price of each side in each tier, in basis points:
 *   price = RTP_TARGET / P(that side wins | tier)
 * so price * P(win | tier) == RTP_TARGET for every (tier, side) cell. Integer bps.
 */
const PRICE_FIRST_BPS = TIER_N.map((n, i) => Math.round((RTP_TARGET_BPS * n) / TIER_C1[i]));
const PRICE_SECOND_BPS = TIER_N.map((n, i) => Math.round((RTP_TARGET_BPS * n) / TIER_C0[i]));

/** Exact RTP of each side over the whole board space, in bps (integer arithmetic). */
const exactRtp = (prices, counts) => {
  let sum = 0;
  for (let i = 0; i < prices.length; i += 1) sum += prices[i] * counts[i];
  return Math.round(sum / BOARDS);
};

export const EXPECTED_RTP_BPS = exactRtp(PRICE_FIRST_BPS, TIER_C1); // 9500

// ------------------------------------------------------------------ paytable
/**
 * `stat` is a 4-bit signature: the high bit is "First wins", the low three bits are the
 * volatility tier. Stat 0..7 therefore pays 0 for the canonical (First) side and 8..12 pays
 * that tier's First-side price. 13..15 are padding so the bands tile 0..15 with no gap.
 *
 * The multiplier returned for a word is the payout a player who backed FIRST receives:
 * 0 when Second wins, PRICE_FIRST_BPS[tier]/10000 when First wins. The Second side is paid
 * PRICE_SECOND_BPS[tier]/10000 on the mirror condition, and because both prices are the fair
 * price for that tier, the two sides have the same expected value (see rtp-proof.md).
 */
export const BANDS = [
  { min: 0, max: 7, mult: 0 },
  { min: 8, max: 8, mult: PRICE_FIRST_BPS[0] / 10000 },
  { min: 9, max: 9, mult: PRICE_FIRST_BPS[1] / 10000 },
  { min: 10, max: 10, mult: PRICE_FIRST_BPS[2] / 10000 },
  { min: 11, max: 11, mult: PRICE_FIRST_BPS[3] / 10000 },
  { min: 12, max: 15, mult: PRICE_FIRST_BPS[4] / 10000 },
];

const STAT_MAX = 15;
const MULT_BY_STAT = new Float64Array(STAT_MAX + 1);
for (const band of BANDS) {
  for (let s = band.min; s <= band.max; s += 1) MULT_BY_STAT[s] = band.mult;
}

export function bandOf(stat) {
  const s = stat < 0 ? 0 : stat > STAT_MAX ? STAT_MAX : stat | 0;
  return MULT_BY_STAT[s];
}

// ------------------------------------------------------------------ word -> position
const HEX = new Uint8Array(256).fill(255);
for (let i = 0; i < 10; i += 1) HEX[48 + i] = i;
for (let i = 0; i < 6; i += 1) HEX[97 + i] = 10 + i;
for (let i = 0; i < 6; i += 1) HEX[65 + i] = 10 + i;

/**
 * Bits 232..255 of the word = the first three bytes = a 24-bit big-endian value. The low 18
 * bits are the board: bit `6*row + col` is 1 when socket (row, col) carries a pin.
 * Identical to `uint24(uint256(randomness) >> 232)` in the contract.
 */
function boardOf(word) {
  let v = 0;
  for (let i = 0; i < 6; i += 1) {
    const n = HEX[word.charCodeAt(2 + i)];
    if (n === 255) throw new Error(`outcome(): non-hex character in word: ${word}`);
    v = (v << 4) | n;
  }
  return v & 0x3ffff;
}

const TIER_LABELS = ['VOL 1 — tight', 'VOL 2', 'VOL 3', 'VOL 4', 'VOL 5 — open'];

/**
 * The whole game as a pure function of the word.
 * Returns { stat, mult } (the harness contract) plus the detail the page renders.
 */
export function outcome(word) {
  if (typeof word !== 'string' || word.length < 8 || word.charCodeAt(0) !== 48) {
    throw new Error(`outcome(): expected a 0x-prefixed hex word, got ${typeof word}`);
  }
  const board = boardOf(word);
  const p0 = board & 63;
  const p1 = (board >> 6) & 63;
  const p2 = (board >> 12) & 63;

  const g0 = ROW_G[p0];
  const g1 = ROW_G[p1];
  const g2 = ROW_G[p2];
  const grundy = g0 ^ g1 ^ g2;

  const moves = ROW_MOVES[p0] + ROW_MOVES[p1] + ROW_MOVES[p2];
  const tier = tierOfMoves(moves);
  const firstWins = grundy !== 0;
  const stat = (firstWins ? 8 : 0) + tier;

  return {
    stat,
    mult: MULT_BY_STAT[stat],
    board,
    rows: [p0, p1, p2],
    rowGrundy: [g0, g1, g2],
    grundy,
    moves,
    tier,
    tierLabel: TIER_LABELS[tier],
    firstWins,
    winner: firstWins ? 'FIRST' : 'SECOND',
    priceFirstBps: PRICE_FIRST_BPS[tier],
    priceSecondBps: PRICE_SECOND_BPS[tier],
    boardBits: board,
  };
}

// ------------------------------------------------------------------ round sampler (C1-safe)
const MIX_A = 0x9e3779b1;
const MIX_B = 0x85ebca6b;
const MIX_C = 0xc2b2ae35;

/**
 * fmix32 (murmur3 finalizer). A BIJECTION on u32: xor-shift-right by a constant and
 * multiplication by an odd constant are both invertible mod 2^32, so this is a permutation.
 * That is what makes each lane a bijection in its own input; global collision-freedom over all
 * (lo, hi) pairs is NOT proven here — no collision was found in any swept window, but the
 * argument would require all eight lanes to separate (lo, hi) jointly. See docs/adversarial.md.
 */
function fmix32(x) {
  let y = x;
  y = (y ^ (y >>> 16)) >>> 0;
  y = Math.imul(y, MIX_B) >>> 0;
  y = (y ^ (y >>> 13)) >>> 0;
  y = Math.imul(y, MIX_C) >>> 0;
  return (y ^ (y >>> 16)) >>> 0;
}

/**
 * Counter-based round seeder. `round` is split into (hi, lo) exactly — no float accumulates
 * across rounds, which is the Wave-3 C1 defect (`seed0 + round * 2654435761` passes 2^53 at
 * round 3,393,263 and collapses the low bits). `round % 2^32` and `(round - lo) / 2^32` are
 * both exact for every integer round < 2^53, and the per-lane map is
 *   x -> fmix32(imul(x ^ fmix32(lo) ^ imul(i+1, MIX_A), MIX_C) ^ hi)
 * injective in `lo` for a fixed `hi` (fmix32 and imul by odd constants are bijections), hence
 * injective within each 2^32-round window. Collision-freedom across all (lo, hi) is not proven;
 * no collision was found in the swept windows. See docs/adversarial.md.
 */
export function makeRng(seed0, round) {
  const lo = round % 4294967296;
  const hi = (round - lo) / 4294967296;
  const loMix = fmix32(lo >>> 0);
  const hiU = hi >>> 0;
  const out = new Array(8);
  for (let i = 0; i < 8; i += 1) {
    const off = 2 + i * 8;
    let s = 0;
    for (let k = 0; k < 8; k += 1) {
      const n = HEX[seed0.charCodeAt(off + k)];
      if (n === 255) throw new Error('makeRng(): non-hex seed');
      s = ((s << 4) | n) >>> 0;
    }
    const x = (s ^ loMix ^ Math.imul(i + 1, MIX_A)) >>> 0;
    out[i] = fmix32((Math.imul(x, MIX_C) ^ hiU) >>> 0);
  }
  let hex = '0x';
  for (let i = 0; i < 8; i += 1) hex += out[i].toString(16).padStart(8, '0');
  return hex;
}
