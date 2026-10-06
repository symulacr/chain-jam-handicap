# HANDICAP — RTP

Declared: **`EXPECTED_RTP_BPS = 9500` (95.0000%)**, exact by enumeration on the board space.

The full derivation, the honest distinction between what is exact and what is sampled, and the Wave-3
C1 post-mortem live in `rtp-proof.md`. This report covers the engineering side: the contract's
numbers, the parity argument, the declared RTP as the harness measured it, and what remains unproven.

## 1. The declared number

| side | exact RTP over the 2^18 board space | declared |
|---|---|---|
| backing FIRST | 9499.9911 bps (94.99991%) | 9500 |
| backing SECOND | 9500.0109 bps (95.00011%) | 9500 |
| gap between the sides | 0.02 bps | — |

`tools/enumerate.mjs` prints both, walking every one of the 262,144 boards and re-deriving the tier
counts with a second implementation of the row DP:

```
exact RTP backing FIRST  94.9999%  (9500 bps)
exact RTP backing SECOND 95.0001%  (9500 bps)
declared EXPECTED_RTP_BPS 9500
gap between the two sides  0.02 bps
ENUMERATION OK
```

Both sides use the same price construction, `price = round(9500 * n_tier / count_of_winning_boards)`,
so the equality is structural rather than tuned.

**Be precise about what the aggregate proves.** Because `price_i = 9500 * n_i / c_i`, the sum
telescopes to 9500 for *any* counts covering the board space, so 9499.9911 / 9500.0109 are the
aggregate plus five prices' integer rounding, not a measured result, and no aggregate test can
falsify them. The enumeration's real content is (a) the tier **counts**, which every price is built
from and which the Solidity paytable mirrors, and (b) the **per-tier** return
`price_i * c_i / n_i`, where rounding does *not* average out: every (tier, side) cell is within
0.295 bps of 9500 and the two sides of a tier agree to within 0.36 bps
(`rtp-proof.md` §2.4, `adversarial.md` §Attack 1).

## 2. Harness measurement (from `docs/verification.txt`)

```
[PASS] 11 rtp truth     9500 bps measured vs 9500 declared (CI +/-7 bps), stat 0..12
[PASS] 12 rtp sampler   9497 bps via makeRng vs 9494 bps independent CSPRNG (diff 3 bps, allowed 60)
[PASS] 13 key space     700,000 round indices across 7 magnitude windows, 0 collisions
```

Check 11 draws 2,000,000 words from `crypto.randomBytes` that this candidate does not control; 9500
against the exact 9500 is a direct hit, and across runs the measurement stays inside one standard
error (±7 bps). Check 12 runs the candidate's own `makeRng` over rounds starting at 5,000,000 (above
2^53, the C1 regime) and compares it with an independent CSPRNG. Check 13 finds 0 duplicate words in
700,000 consecutive round indices across windows at 1, 1e3, 1e6, 1e8, 1e9, 1e12 and 2^52.

Because both of those checks are Monte Carlo comparisons they move by a few bps between runs
(observed 9495..9506 for check 11 and 1..8 bps of sampler-vs-CSPRNG difference, against a 60 bps
tolerance). The number that does not move is the enumerated one in §1.

## 3. Contract parity — the argument, band for band

The contract does not re-implement the payline; it **carries the same integer tables**, which is the
strongest available form of parity because nothing is left to drift.

```
$ cd contracts && solc --version | tail -1
Version: 0.8.34+commit.80d5c536.Linux.g++
$ solc --optimize --optimize-runs 200 --bin --bin-runtime -o /tmp/hc-wave3-opt --overwrite HandicapGame.sol
Compiler run successful.
HandicapGame.bin           2561 bytes creation
HandicapGame.bin-runtime   2533 bytes runtime
$ solc --bin -o /tmp/hc-wave3-noopt --overwrite HandicapGame.sol      # no optimizer
HandicapGame.bin           4068 bytes creation
```
(These are the current sizes, measured in Wave 3 after the S2 fix — `_committedPick` added 109 B to
each; `docs/security.md` §1. The candidate-phase figures were 2452 / 2424 / 3919.)

`solcjs` is not installed in this environment; the native `solc` 0.8.34 binary is used instead. Same
compiler version pin (`^0.8.30` in the source, 0.8.34 used), same output class (`--bin`).

| quantity | `model.mjs` | `HandicapGame.sol` | how parity is established |
|---|---|---|---|
| board decode | first 3 bytes big-endian, low 18 bits | `(uint256(randomness) >> 232) & 0x3ffff` | `tools/enumerate.mjs` re-encodes the Solidity expression from three bytes and checks all 2^18 boards — 0 mismatches |
| row Grundy table | `ROW_G`, 64 entries, memoised DP | `ROW_G_PACKED`, one `uint256`, 4 bits per entry | `tests/model.test.mjs` asserts the contract source contains `String(packedTable)` verbatim |
| row legal-move table | `ROW_MOVES`, 64 entries | `ROW_MOVES_PACKED` | same |
| tier thresholds 19 / 14 / 11 / 7 | `tierOfMoves()` | `_tier()` | the test walks all 2^18 boards and checks every branching value lands in the documented tier |
| First-side prices | `BANDS.filter(min>=8).map(round(mult*1e4))` = 10771, 12260, 12325, 12639, 14068 | `PRICE_FIRST_PACKED` | the test unpacks the constant with BigInt (`(packed >> 32t) & 0xffffffff`) and compares each field |
| Second-side prices | 80492, 42195, 41451, 38252, 29258 | `PRICE_SECOND_PACKED` | same |
| declared RTP | `EXPECTED_RTP_BPS = 9500` | `EXPECTED_RTP_BPS = 9500` | asserted present in the contract source |
| payout | `price_bps / 10000` | `(wager * priceBps) / 10000` | the same integer division; both sides round in the same direction |
| reserve quote | — | `MAX_PRICE_BPS = 80492` = max over both tables | the constant equals the largest field in either packed table |

Because both artefacts hold **the same integers** and divide by the same 10000, there is no
floating-point or ordering difference to reconcile. The test suite re-checks the unpacking on every
run, so a drift in either file fails the build rather than shipping.

Test evidence:

```
$ node --test tests/model.test.mjs
✔ contract price tables match model.mjs band-for-band
✔ contract carries the model table constants verbatim
✔ moves/tier boundaries
✔ both sides of the book return the same RTP (within 1 bp)
✔ exact RTP across the whole 2^18 board space matches the declaration
...
13 tests, 0 failures
```

## 4. Why the payline is graded rather than binary

If the winner were paid flat, `outcome(word)` would still be a pure function of the word but the
game would have one price and no spread. The five volatility tiers give ten distinct payouts,
1.0771x .. 8.0492x, and every tier is priced at the same target on both sides — so no tier is a
better bet than another, and the "spread" is genuine (the position you are dealt decides your
variance, not your edge).

## 5. Defect history

`research/wave5-contradictions.md` C1 shipped a correct game (94.717% RTP) with a false declaration
of 96.816%, because the *round sampler* — not the paytable — was broken
(`seed0 + round * 2654435761`, which passes 2^53 at round 3,393,263). What this build does about it:

1. `makeRng` never accumulates a float across rounds. `round` is split exactly into `lo = round % 2^32`
   and `hi = (round - lo) / 2^32`; both are exact for every integer round < 2^53.
2. The per-lane map is a composition of bijections — `fmix32(imul(x ^ fmix32(lo) ^ imul(i+1, A), C) ^ hi)`
   where `fmix32` is a permutation of u32 and `C` is odd — hence **injective in `lo` for a fixed `hi`**,
   and therefore injective within each 2^32-round window (which covers every run performed). Injectivity
   over ALL `(lo, hi)` is **not proven**: it would require all eight lanes to separate `(lo, hi)` jointly.
   The harness's 700,000-index sweep found no collision, but that is a cross-check, not a proof.
3. The declared RTP is not the sampler's number: it comes from enumerating the board space, and the
   harness re-derives it from words this candidate does not control.

## 6. Unproven (corrected in Wave 3; see `docs/verification.txt` §3.8)

| claim | status |
|---|---|
| RTP exact on the board space | **PROVEN** — enumeration + a second DP implementation + the tests, plus the coordinator's independent exact re-derivation over 2^24 (`verify-exact-rtp.mjs`: 9499.9911 bps vs the declared 9500) |
| both sides fair in every tier | **PROVEN** — the price formula is derived from the exact counts |
| model/contract paytable parity | **PROVEN**, source-level (BigInt-unpacked and compared) *and* at runtime: the deployed contract settled 21 sessions on the local simulator with the on-chain payout equal to `model.outcome(randomness)`, 0 parity failures (`docs/chain-proof.json`). Production-chain runtime **UNPROVEN**. |
| gas cost of a settlement | **UNPROVEN for a settlement** — the deploy `gasUsed` (471895) is now recorded (`research/chain-evidence.json`), but no per-settlement gas figure was captured |
| harness PASS | **PROVEN** — `docs/verification.txt` is the verbatim output, exit code 0 |
