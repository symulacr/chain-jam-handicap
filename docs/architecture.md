# HANDICAP — architecture

## The position, and why Kayles

One VRF word deals an 18-socket board, 3 rows × 6 columns. A filled socket is a pin. The position
is **Kayles** — the classic impartial pin game, octal game `.77`. On your turn you knock down
exactly one pin, or two adjacent pins inside a row; the player who cannot move loses.

A row's Grundy value depends only on its own 6-bit pattern, so the position is the disjoint sum of
three independent row games and Sprague-Grundy gives

```
G(position) = G(row A) XOR G(row B) XOR G(row C)
First wins under perfect play  <=>  G != 0
```

That is the whole money decision, and it is a pure function of the word.

### Substitution from the brief, stated plainly

`wave6-build-brief.md` §6.5 offered "Node-Kayles on a seeded graph of ≤ 18 vertices, **or** a seeded
subtraction game". This build ships Kayles, a third member of the same family. The reason is cost,
not taste:

| game | exact Grundy cost | verdict |
|---|---|---|
| Node-Kayles on an 18-vertex graph | memoised DFS over vertex subsets: up to 2^18 subgames, ~4.7M mex steps and megabytes of memo | **not shippable in a settlement path** — the contract would run out of gas |
| seeded subtraction game | O(heap × moves) DP | cheap, but the "branching factor" collapses to a constant for large heaps, so it cannot carry a graded payline |
| **Kayles on rows** (shipped) | per-row table is a 64-entry DP over 6-bit patterns | **cheap** (two packed `uint256` lookups in the contract) and the branching factor `sum over runs of (2L-1)` takes 25+ distinct values |

Kayles is not a simplification of the money claim: the settlement still computes the **exact**
Sprague-Grundy value, and the winner is still fully determined before any move is played.

## Where the money is decided

**The contract decides the money. The browser cannot.**

| step | where it happens | file |
|---|---|---|
| the side (FIRST/SECOND) is committed pre-wager | `onSessionStart` writes `gameState = abi.encode(uint256(pick))` | `contracts/HandicapGame.sol` |
| the board is dealt from the VRF word | `onRandomness` reads `(uint256(randomness) >> 232) & 0x3ffff` | `contracts/HandicapGame.sol` |
| the exact Grundy value and branching factor | two packed `uint256` table lookups (`ROW_G_PACKED`, `ROW_MOVES_PACKED`) | `contracts/HandicapGame.sol` |
| the tier and the price | `_tier()` + `_priceFirst/_priceSecond()` (`PRICE_FIRST_PACKED`, `PRICE_SECOND_PACKED`) | `contracts/HandicapGame.sol` |
| the payout | `_payout(ctx.wagerBase, price) = wagerBase * priceBps / 10000`, returned in `StepResult.payout` | `contracts/HandicapGame.sol` |
| drawing the result | reads `contractGame` from the settled session | `src/app.js` (`reveal`) |

The embed path takes the position **and the payout** from the contract's `gameState` (six ABI words:
`board, grundy, moves, tier, pick, payout`) and re-runs `outcome()` on the board-derived word purely
as a parity display (`MODEL: matches contract`). The standalone demo computes the multiplier from
`model.mjs` because there is no chain and no money; it is a demo. In the money path the page is a
renderer: it never computes a payout it then trusts over the chain's.

`onSessionStart` commits the full worst-case reserve and `onRandomness` returns
`reservedProfitDelta = 0`, so the reserve budget (`ctx.escrowedStake + ctx.reservedProfit`) is
exactly the maximum payout `wager * 80492 / 10000`; `quoteCaps`, `quoteRiskParams`, `onSessionStart`
and `onRandomness` all route through the single `_payout()` so the cap and the payout cannot
disagree. Every handler is `pure`, so the game holds no state and cannot reenter.

## The payline, and why it is graded

The winner is binary, so a flat payout would be a coin flip with one price — exactly the weakness
the novelty note flags for this candidate. So the payout is graded by the position's **volatility
tier** (its branching factor bucketed into five levels) and each tier quotes its own price on **each
side**:

| tier | branching | P(FIRST wins) | price FIRST | price SECOND |
|------|-----------|---------------|-------------|--------------|
| 0 | 19..33 | 0.8820 | 1.0771× | 8.0492× |
| 1 | 14..18 | 0.7749 | 1.2260× | 4.2195× |
| 2 | 11..13 | 0.7708 | 1.2325× | 4.1451× |
| 3 | 7..10 | 0.7516 | 1.2639× | 3.8252× |
| 4 | 0..6 | 0.6753 | 1.4068× | 2.9258× |

Each price is `9500 / P(that side wins | tier)`, so both sides of the book return the same expected
value **in every tier**, not merely on average. The pick is therefore a choice of variance (short
favourite vs long underdog), not of edge — what a real two-sided handicap book is. Tier index order
is the First-side price ascending, so `BANDS` is monotonically non-decreasing and the harness's
paytable check passes by construction.

## `stat` layout

```
stat = (FIRST wins ? 8 : 0) + tier        // 0..15

BANDS = [ 0..7 -> 0,  8 -> F0,  9 -> F1,  10 -> F2,  11 -> F3,  12..15 -> F4 ]
```

`bandOf(stat)` returns the payout to a player who backed **FIRST**: 0 when SECOND wins, else that
tier's First-side price. The Second side is paid on the mirror condition at its own price; both are
pure functions of the word, and the contract carries the same integer tables (see `rtp.md`).

## Files and responsibilities

| file | role |
|---|---|
| `game/model.mjs` | the single source of truth: row-Grundy DP, tier map, prices, `outcome`, `makeRng`. Exports exactly `SLUG, BANDS, EXPECTED_RTP_BPS, bandOf, outcome, makeRng`. |
| `index.html` | the markup and the asset wiring: `./src/styles.css`, `./src/app.js`, a `modulepreload` for `./game/model.mjs`, and the widget tag. No inline logic. |
| `src/app.js` | the frontend app: imports `../game/model.mjs` and `./sdk/guest.mjs`; one `reveal()` path shared by demo and embed; the host bridge lifecycle. |
| `src/styles.css` | the chrome (extracted from the candidate's inline style block; no `url()` fetches). |
| `contracts/HandicapGame.sol` | `ICasinoGameV2`; the same tables packed into `uint256`s; where the money is decided. |
| `contracts/ICasinoGameV2.sol` | the host interface, copied byte-identically from the proven prototype. |
| `src/sdk/guest.mjs` | the Chain guest bridge, copied byte-identically from `jam-candidates/shared/` (sha256 `46263af1…e75fe`). |
| `game.manifest.json` | the host manifest (`public/`, copied to the dist root by the build). |
| `tools/enumerate.mjs` | the exhaustive proof over the 2^18 board space and the word→board parity check. |
| `tools/build.mjs`, `tools/check.mjs`, `tools/serve.mjs`, `tools/browser-check.mjs` | build (plain copy), syntax check, static server, DevTools-Protocol acceptance driver. |
| `tests/model.test.mjs` | 13 tests including an independent brute-force Kayles search and the contract-parity checks. |

## Data flow

```
word --(bits 232..255)--> board (2^18) --(3 row lookups)--> { g, moves }
                                      |
                                      +---> tier = bucket(moves)
                                      |
                                      +---> First wins = (g != 0)
                                              |
                        stat = gbit*8 + tier  ->  bandOf(stat) = payout (First side)

demo:   crypto.getRandomValues(32 B) -> word --^  (model.mjs prices it; no money)
embed:  VRF word in the settled session -> the same renderer; the position AND the
        payout come from the contract's gameState (the chain already decided both)
```

Both paths run the same `reveal()` function. The demo computes the multiplier from `model.mjs`; the
embed path takes the position and the payout from the contract's `gameState` and re-runs `outcome()`
on the board-derived word purely as a parity display.

## The build

`npm run build` assembles `dist/` by a straight copy (no bundler, no runtime dependency):

```
index.html          -> dist/index.html
game/               -> dist/game/            (../game/model.mjs resolves from src/app.js)
src/                -> dist/src/             (app.js, styles.css, sdk/guest.mjs)
public/*            -> dist/ root            (game.manifest.json, og-image.png, _headers, vercel.json)
```

Served from `dist/`, the page's relative paths resolve exactly as in the source tree:
`index.html` → `./src/styles.css`, `./src/app.js`; `src/app.js` → `../game/model.mjs`,
`./sdk/guest.mjs`; the manifest's `assets` and the page's `og:image` → `og-image.png` at the root.

## Failure modes considered

| risk | handling |
|---|---|
| C1 sampler collapse | `makeRng` is counter-based and provably injective in `(lo, hi)`; see `rtp.md` §5 |
| page and contract disagreeing on the paytable | the contract carries the model's integers verbatim; `tests/model.test.mjs` unpacks the Solidity constants with BigInt and compares band-for-band |
| bit-order disagreement between JS and Solidity | `tools/enumerate.mjs` re-encodes `uint24(uint256(word) >> 232)` independently and checks all 2^18 boards |
| settling the wrong side | the committed side is read back from `gameState` (`_committedPick`), with `gameData` only as a fallback; see `security.md` |
| embed path hanging with no host | a 2.5 s timer forces standalone mode; `openSession` failures and a 90 s settlement watchdog both return control to the UI |
