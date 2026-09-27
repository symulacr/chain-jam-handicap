# HANDICAP — RTP proof

**Declared: `EXPECTED_RTP_BPS = 9500` (95.0000%).**

This document states exactly what kind of claim that is. It is **exact by enumeration on the
board space**, and it is an **empirical check on the seed space**, because the two are not the
same object.

---

## 1. What is exact and what is sampled

`outcome(word)` reads bits 232..255 of the 256-bit VRF word (the first three bytes), takes the low
18 bits as the board, and ignores the other 238 bits. Therefore:

| object | space | status |
|---|---|---|
| board (the position) | 2^18 = 262,144 | **exactly enumerable** |
| the mapping word -> board | — | measure preserving: each board is hit by exactly 2^238 equally likely words |
| the distribution over positions | — | **exactly uniform on 2^18 states** |
| the Grundy value of a position | — | **exact**, integral, no search bound |
| the payout of a position | — | **exact**, an integer bps table |
| the VRF word itself | 2^256 | **not enumerable** — only its pushed-forward distribution is needed, and that is exact |

So the RTP is *not* a Monte Carlo estimate of anything: the outcome function is deterministic, the
position distribution is exactly uniform on a finite set, and the paytable is integers. The RTP is
an exact weighted sum. **There is no sampled quantity in the declaration.**

What Monte Carlo is used for is only *corroboration*: `tools/verify-candidate.mjs` re-derives the
RTP from 2,000,000 `crypto.randomBytes` words that this candidate does not control, and separately
compares the candidate's own `makeRng` rounds against an independent CSPRNG. Both are recorded in
`docs/verification.txt`. Those are checks on the *implementation*, not the source of the number.

---

## 2. The exact derivation

### 2.1 Board -> Grundy

Rows are independent Kayles row games, so the position's Grundy value is the XOR of the three row
values (Sprague-Grundy: `G(A + B) = G(A) XOR G(B)`). The row table is a memoised DP:

```
G(0) = 0
G(L) = mex{ G(i) XOR G(L-i-1) : 0 <= i < L }        // knock down one pin
       ∪ { G(i) XOR G(L-i-2) : 0 <= i <= L-2 }      // knock down two adjacent pins
G(0..6) = 0, 1, 2, 3, 1, 4, 3        // the classic Kayles sequence
```

`First wins iff g != 0`. Independently of that DP, `tests/model.test.mjs` contains a brute-force
search over row bitmasks (no run decomposition, no shared table) and asserts the two agree on all
64 patterns.

### 2.2 Board -> volatility tier

`moves` = the branching factor = the number of legal moves = `sum over maximal runs of length L of
(2L-1)`. Bucketed:

| tier | branching | boards | P(FIRST wins) | exact count First | exact count Second |
|---|---|---|---|---|---|
| 0 | 19..33 | 22,309 | 0.88198 | 19,676 | 2,633 |
| 1 | 14..18 | 84,625 | 0.77489 | 65,572 | 19,053 |
| 2 | 11..13 | 75,162 | 0.77080 | 57,936 | 17,226 |
| 3 | 7..10 | 67,005 | 0.75164 | 50,364 | 16,641 |
| 4 | 0..6 | 13,043 | 0.67530 | 8,808 | 4,235 |
| | | **262,144** | 0.77193 | **202,356** | **59,788** |

These are the counts printed by `node tools/enumerate.mjs`; they are
hard-coded in `model.mjs` (`TIER_C0`, `TIER_C1`, `TIER_N`) and again in the contract, and every
copy is asserted equal by the test suite.

### 2.3 Tier -> price (the graded payline)

Each tier is priced at the target return on **both** sides:

```
priceFirst[t]  = round(9500 * n[t] / c1[t])      ->  10771, 12260, 12325, 12639, 14068
priceSecond[t] = round(9500 * n[t] / c0[t])      ->  80492, 42195, 41451, 38252, 29258
```

`priceFirst[0] = round(9500 * 22309 / 19676) = round(10771.2) = 10771`, and so on. The property
that makes the book fair: `priceFirst[t] * c1[t] ~= 9500 * n[t]` and `priceSecond[t] * c0[t] ~=
9500 * n[t]`, so **every (tier, side) cell** returns the target, not merely the average.

### 2.4 The declared number

```
RTP_backing_FIRST  = sum_t priceFirst[t]  * c1[t] / 2^18 = 9499.9911 bps -> 9500
RTP_backing_SECOND = sum_t priceSecond[t] * c0[t] / 2^18 = 9500.0109 bps -> 9500
```

Both sides land on the same integer. `EXPECTED_RTP_BPS = 9500` is the model's exported constant,
and the same integer appears in the contract.

**Honest asymmetry note.** The two sides are not symmetric in *price*, only in *expected value*.
The position family favours the first player (P(FIRST) = 0.7719 overall), so FIRST is short-priced
(1.0771x..1.4068x) and SECOND is long-priced (2.9258x..8.0492x). That is a handicap book, and it is
the reason the payline is graded rather than a single binary price.

---

## 3. Independent cross-checks

| check | who performs it | result |
|---|---|---|
| harness RTP truth — 2,000,000 `crypto.randomBytes` words the candidate does not control | `tools/verify-candidate.mjs` check 11 | 9506 bps measured vs 9500 declared, 95% CI ±7 bps, delta 6 bps ~ 0.9σ — see `docs/verification.txt` |
| harness RTP sampler — the candidate's own `makeRng` vs an independent CSPRNG draw | check 12 | 9496 vs 9501 bps, diff 5 bps (allowed 60) |
| exact enumeration of all 2^18 boards, second implementation of the row DP | `handicap/tools/enumerate.mjs` | 94.9999% / 95.0001%, 0 word->board mismatches, 0 Grundy mismatches |
| row Grundy table vs brute-force bitmask search | `tests/model.test.mjs` | 64/64 patterns agree |
| model price bands vs the contract's packed tables | `tests/model.test.mjs` | band-for-band equal |
| every tier boundary exercised | `tests/model.test.mjs` | all 25+ branching values map to the documented tier |

---

## 4. Contract parity argument

The contract does not re-derive the payline; it **carries the same integers**, which is the
strongest available parity because it leaves no arithmetic to drift:

| quantity in `model.mjs` | in `HandicapGame.sol` | how parity is established |
|---|---|---|
| board decode, bits 232..255, low 18 = board | `(uint256(randomness) >> 232) & 0x3ffff` | the same expression; `tools/enumerate.mjs` re-encodes it a second time and checks all 2^18 boards |
| row Grundy table (`ROW_G`, 64 entries) | `ROW_G_PACKED` (4 bits per entry, one `uint256`) | the decimal constant is `toString()` of the model's packed table and the test asserts the literal appears in the source |
| row move table (`ROW_MOVES`, 64 entries) | `ROW_MOVES_PACKED` | same |
| tier thresholds 19 / 14 / 11 / 7 | `_tier()` | `tests/model.test.mjs` walks all 2^18 boards and checks every branching value maps to the documented tier |
| `PRICE_FIRST_BPS[0..4]` | `PRICE_FIRST_PACKED` | the test unpacks the contract constant with BigInt and compares to `Math.round(bandOf(8+t) * 10000)` |
| `PRICE_SECOND_BPS[0..4]` | `PRICE_SECOND_PACKED` | same |
| `EXPECTED_RTP_BPS = 9500` | `EXPECTED_RTP_BPS = 9500` | asserted present in the contract source |
| `EXPECTED_RTP_BPS` in the reserve quote | `MAX_PRICE_BPS = 80492` | max over both price tables; the contract's `quoteCaps` and `quoteRiskParams` route through the single `_payout()` |

Because both sides use the **same integer tables** and the same `payout = wager * price / 10000`,
there is no floating-point or ordering difference to reconcile: a band in `BANDS` and a packed
field in `PRICE_FIRST_PACKED` are the same four digits, checked by the test suite on every run.
The manifest's `capabilities.submitAction` is `false` and the contract's `onPlayerAction` reverts,
so they agree there too.

---

## 5. Defect history and what changed because of it

`research/wave5-contradictions.md` **C1**: Wave 3 declared **96.816%**; the true figure was
**91.78%**. The paytable was fine. The **round sampler** was broken:

```js
const seed = seed0 + round * 2654435761;   // passes 2^53 at round ~3,393,263
```

Past 2^53 the float spacing is >= 2, so the low bits are destroyed and `>>> 0` sees a degenerate
value; a third of a 5M-round run collapsed onto duplicated seeds. `tune.mjs` then "proved" its own
paytable with its own broken sampler, so the two agreed and nothing looked wrong.

What this candidate does about it:

1. **No float accumulates across rounds.** `makeRng(seed0, round)` is counter-based: `round` is
   split exactly into `lo = round % 2^32` and `hi = (round - lo) / 2^32` (both exact for every
   integer round < 2^53), then mixed with a composition of bijections
   (`fmix32(imul(x ^ fmix32(lo) ^ imul(i+1, A), C) ^ hi)`). Every step is `Math.imul` / `>>> 0` /
   `^` / `+` on u32 lanes; no float is ever carried.
2. **Collision-free by construction, not by test.** `fmix32` is a permutation of u32 (xor-shift and
   multiplication by an odd constant are invertible mod 2^32), and the round is folded in as an XOR
   with `hi` *before* an `imul` and with `fmix32(lo)` before it, so distinct `(lo, hi)` pairs cannot
   collide. The harness's key-space check nonetheless sweeps 700,000 round indices across seven
   magnitude windows up to 2^52 and reports 0 duplicates.
3. **The declared number is not the sampler's number.** The headline RTP here is derived by
   enumeration, and the harness re-derives it from words this candidate does not control. The
   sampler is checked *against* that, not against itself.
4. **The label is accurate.** This is exact-by-enumeration, which is a stronger claim than Wave 3's
   "empirically validated, not closed-form proven" — but the claim is narrow: it is exact *because
   the position space is 2^18 and the paytable is integers*, not because the seed space is small.

## 6. Reproduce

```sh
node tools/enumerate.mjs
node --test tests/model.test.mjs
node jam-candidates/tools/verify-candidate.mjs top3/02-handicap
```
