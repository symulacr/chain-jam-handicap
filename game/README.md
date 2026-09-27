# HANDICAP — the model

`game/model.mjs` is the single source of truth for the outcome function and the payline. It exports
exactly `SLUG, BANDS, EXPECTED_RTP_BPS, bandOf, outcome, makeRng`, is a pure function of one word,
and is imported by the page (`src/app.js`), by the tests, and by the enumerator. Nothing is
transcribed from it — the contract holds the same integers, checked band-for-band by the tests.

## The mechanic

One VRF word deals an **18-socket board**: 3 rows (A, B, C) × 6 columns. A filled socket is a pin.
The position is **Kayles**, the classic impartial combinatorial game (octal game `.77`): on your
turn you knock down **exactly one pin, or two adjacent pins inside a row**, and the player who
cannot move loses.

A row's Grundy value depends only on its own 6-bit pattern, so the position is the disjoint sum of
the three independent row games and Sprague-Grundy gives the **exact** value with no search:

```
G(position) = G(row A) XOR G(row B) XOR G(row C)

g != 0  ->  FIRST wins under perfect play
g == 0  ->  SECOND wins under perfect play
```

The row table is a memoised DP evaluated once at load:

```
G(0) = 0
G(L) = mex{ G(i) XOR G(L-i-1) : 0 <= i < L }          // knock down one pin
        ∪ { G(i) XOR G(L-i-2) : 0 <= i <= L-2 }        // knock down two adjacent pins
G(0..6) = 0, 1, 2, 3, 1, 4, 3
```

`outcome(word)` returns the Grundy value, the per-row values, the branching factor, the volatility
tier, the winner, the `stat` signature and the two tier prices. `tests/model.test.mjs` compares the
64-entry row table against an **independently written brute-force Kayles search over row bitmasks**
(no run decomposition, no shared table) and asserts they agree on all 64 patterns.

## The payline — five volatility tiers, priced on each side

The winner is binary, so a flat payout would be a coin flip with one price. The payout is graded by
the position's **volatility tier**, which is its branching factor (the number of legal moves,
`sum over maximal runs of length L of (2L-1)`) bucketed into five levels. **Each tier quotes its own
price on each side**:

| tier | branching | P(FIRST wins) | price FIRST | price SECOND |
|------|-----------|---------------|-------------|--------------|
| 0 | 19..33 | 0.8820 | 1.0771× | 8.0492× |
| 1 | 14..18 | 0.7749 | 1.2260× | 4.2195× |
| 2 | 11..13 | 0.7708 | 1.2325× | 4.1451× |
| 3 | 7..10 | 0.7516 | 1.2639× | 3.8252× |
| 4 | 0..6 | 0.6753 | 1.4068× | 2.9258× |

Each price is the **fair price for that tier**:

```
priceFirst[t]  = round(9500 * n[t] / c1[t])   ->  10771, 12260, 12325, 12639, 14068  bps
priceSecond[t] = round(9500 * n[t] / c0[t])   ->  80492, 42195, 41451, 38252, 29258  bps
```

where `n[t]` is the number of boards in the tier, `c1[t]` the boards where FIRST wins, `c0[t]` the
boards where SECOND wins. Because `price × P(win | tier) ≈ 9500` on **both** sides of every tier,
every `(tier, side)` cell returns the same target — the whole book is fair tier by tier, not just
on average. Tier index order is the First-side price ascending, so `BANDS` is monotonically
non-decreasing in `stat`.

The `stat` signature is a 4-bit value: the high bit is "FIRST wins", the low three bits are the
tier. `bandOf(stat)` returns the payout to a player who backed **FIRST** (0 when SECOND wins, else
that tier's First-side price). The Second side is paid on the mirror condition at its own price.

```
stat = (FIRST wins ? 8 : 0) + tier          // 0..15
BANDS = [ 0..7 -> 0,  8 -> F0,  9 -> F1,  10 -> F2,  11 -> F3,  12..15 -> F4 ]
```

## The VRF mapping — the word's top 24 bits ARE the board

`outcome(word)` reads **bits 232..255** of the 32-byte VRF word — its first three bytes, taken as a
24-bit big-endian integer — and keeps the **low 18 bits as the board**. Nothing else in the word is
read, and nothing outside the word is used at all.

```
bit 6*row + col  == 1   =>  socket (row, col) carries a pin
row 0 = bits 0..5,  row 1 = bits 6..11,  row 2 = bits 12..17
```

This is identical to `uint24(uint256(randomness) >> 232)` in `contracts/HandicapGame.sol`. Since
those 18 bits of a uniform word are uniform and independent, the dealt board is **exactly uniform
over the 2^18 possible boards** — the only distributional assumption in the game, and the reason the
RTP is exactly enumerable. There is no `byte % N` rejection loop and no modulo bias to debias.

The page shows the word and the board so a reviewer can see exactly which bits were used. The other
238 bits carry no information that the board does not already determine (the board fixes the Grundy
value, the branching factor, the tier and the payout).

## The RTP class — EXACT 9500

`EXPECTED_RTP_BPS = 9500` is **exact by enumeration on the board space**, not a Monte Carlo
estimate. The board space is 2^18 = 262,144; the outcome function is deterministic; the paytable is
integers; the position distribution is exactly uniform; therefore the RTP is an exact weighted sum:

```
RTP_backing_FIRST  = sum_t priceFirst[t]  * c1[t] / 2^18 = 9499.9911 bps -> 9500
RTP_backing_SECOND = sum_t priceSecond[t] * c0[t] / 2^18 = 9500.0109 bps -> 9500
```

`tools/enumerate.mjs` walks all 2^18 boards, re-derives the tier counts with a second implementation
of the row DP, re-encodes the Solidity bit extract independently, and prints `ENUMERATION OK`. The
window `[9300, 9800]` bps is the jam's accepted band; `9500` sits inside it.

`makeRng(seed0, round)` is a counter-based round sampler (used by the harness and the sample word,
not by the deal itself). It never accumulates a float across rounds and is injective in `lo` for a
fixed `hi`, hence injective within each 2^32-round window, so it cannot reproduce the Wave-3 C1
sampler collapse. Collision-freedom across all `(lo, hi)` is not proven (no collision was found in any
swept window). Derivation: `docs/rtp-proof.md` §5; see also `docs/adversarial.md`.

## Reproduce

```sh
npm test            # 13 model + contract-parity tests, incl. the brute-force Grundy reference
npm run enumerate   # exhaustive RTP proof over 2^18 boards; FIRST/SECOND = 9500 bps
```
