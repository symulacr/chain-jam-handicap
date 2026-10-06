# HANDICAP — security

Adversarial review of the candidate phase, recorded in
`research/wave7-audit-novelty-licensing-security.md` (scope: `flood-exe`, `ordered-runs`,
`jump-ladder`, `lifeboat`, `handicap`). This document carries HANDICAP's findings forward, records
the one code change made in the restructure, and states what is still UNPROVEN.

## 1. The one code fix applied in this restructure

**Finding S2 (LOW, from the audit).** In the candidate, `onRandomness` re-read the committed side
from `ctx.gameData` rather than from the `gameState` that `onSessionStart` had written, leaving the
committed state as dead code. The audit's exact words:

> `onRandomness` reads the committed side from `ctx.gameData` (`:171`), **not** from the
> `ctx.gameState` it wrote at `onSessionStart` (`:154`, `:156`). `lifeboat` deliberately reads the
> locked rule back from `gameState`. If the host ever replayed a session with mutated `gameData`,
> the settlement could grade the wrong side. No exploit exists while `onRandomness` receives the
> word atomically (the board is unknowable before the word), but the asymmetry is a latent
> robustness bug and the committed `gameState` is dead code.

**Fix applied.** `contracts/HandicapGame.sol` now reads the committed side back from `gameState`:

```solidity
/// @dev The side the player COMMITTED, read back from the gameState written at
///      onSessionStart (abi.encode(uint256 pick)) rather than re-read from gameData.
function _committedPick(SessionContext calldata ctx) internal pure returns (uint8) {
  bytes calldata gs = ctx.gameState;
  if (gs.length == 32) {
    uint256 v = abi.decode(gs, (uint256));
    if (v == 1 || v == 2) return uint8(v);
  }
  return _pick(ctx.gameData);   // fallback: a context with no committed state
}
```

`onRandomness` calls `_committedPick(ctx)` instead of `_pick(ctx.gameData)`.

**Why this cannot change verified behaviour.** The committed value is written by `onSessionStart` as
`abi.encode(uint256(pick))` from exactly the same `pick` that `gameData` carried, so under the host
lifecycle both paths always agree. If a context has not passed through `onSessionStart` (or supplies
no state), the function falls back to `gameData` — the candidate's original behaviour. The payout
therefore cannot regress; the committed state is simply the authority once it exists.

**Re-verification after the fix (all re-run in this restructure):**

| check | command | result |
|---|---|---|
| contract still compiles | `solc --optimize --optimize-runs 200 --bin --bin-runtime HandicapGame.sol` | `Compiler run successful.` |
| bytecode size | — | **2561 B creation / 2533 B runtime** (was 2452 / 2424: **+109 B** for `_committedPick`) |
| paytable parity, band-for-band | `npm test` → `contract price tables match model.mjs band-for-band` | PASS (the price/row tables are untouched) |
| model tables verbatim in the contract | `npm test` → `contract carries the model table constants verbatim` | PASS |
| exact RTP reproduced | `npm run enumerate` | FIRST 9500 bps / SECOND 9500 bps, `ENUMERATION OK` |
| all model tests | `npm test` | 13 passed, 0 failed |
| full harness | `verify-candidate.mjs top3/02-handicap` | PASS |

The contract's `_payout`, reserve discipline and price tables were **not** touched.

## 2. Reentrancy — no path (all handlers `pure`)

The interface declares the step handlers `external view`; every implementation here is stricter —
`external pure`. A `pure` function has no state reads or writes and makes no external calls, so the
game cannot reenter the host's value-moving entrypoints (which are `nonReentrant` and use
checks-effects-interactions). The audit confirmed the same for all five candidates.

## 3. Payout cap — exact at the top band

`onSessionStart` commits `reservedProfitDelta = escrowedStake * 80492 / 10000 - escrowedStake`, and
`onRandomness` returns `reservedProfitDelta = 0` and `escrowDelta = 0`. The settle-time cap is
`escrowedStake + reservedProfit = wager * 80492 / 10000`, which is exactly `_payout` at the top band
`80492` bps. `quoteCaps.maxReservedProfit` and `quoteRiskParams.maxPayout` are the same expression
∓ `w`, and every payout routes through the single `_payout()`, so the budget equals the maximum
payout to the wei. Integer floor division in `_payout()` can only round **down**, never above the
cap.

## 4. Heavy-tail rule — NOT heavy-tail

The rule: heavy-tail ⇔ `maxPayout / wager > 100` **and** `probabilityWad < 1e15`. For HANDICAP the
top band is `80492 / 10000 = 8.0492×` (`< 100`), and `TOP_BAND_PROBABILITY_WAD = 10044097900390625`
= 1.0044% (`> 1e15`), so the game is **not** on the heavy-tail path. `quoteRiskParams` nonetheless returns a nonzero, side-specific `bodyVarianceScaled` (worst side
`= wager² × 2734806412979170708`, the SECOND side's variance with its top tier removed), which is
correct and harmless.
The audit independently reproduced the top-band count `2633 / 2^18` by enumeration.

## 5. Overflow / rounding

`wager * MAX_PRICE_BPS` and `wager * wager * BODY_VAR_SCALED` overflow only far above any realistic
wager, and the `int256(...)` reserve cast further out still. All payout math is floor-divided, so any
fractional wei favours the house, never the player. The game does not clamp the wager itself; the
host owns min/max (`docs/` chain notes), and the page pre-clamps against the host's published limit
when one is available (`src/app.js`, `maxWagerBase`).

## 6. Duplicate settlement / replay

The contract is `pure` and carries no storage: the payout is a deterministic function of
`(randomness, committed side)`, so nothing can be incremented twice and `onRandomness` is idempotent
for a given word. Double settlement is prevented host-side by the facet's `nonReentrant` +
finalize-before-transfer ordering (`vendor/casino-sdk/docs/CONTRACT_CONSTRAINTS.md`). Game-level:
**PROVEN**. Host-level guarantee: documented, not re-run here (**UNPROVEN live**).

## 7. UI / iframe surface

- `connection.promise` never settles with no host → a 2.5 s grace timer forces the standalone demo
  (`src/app.js`). This is the bug the audit's S4 class flags; HANDICAP has it.
- No root-relative asset path, no `X-Frame-Options`, no CSP `frame-ancestors` excluding
  `*.chain.wtf`, no service worker, no storage, no cookie, no `window.open`, no `vh`/`vw` units.
  `public/_headers` and `public/vercel.json` set CORS on the manifest only and deliberately no
  framing blocker.
- The page never reads the query string, so `?ref=chainjam` is inherently tolerated.
- The settlement watchdog is 90 s (`src/app.js`): if no settlement is observed the UI is released and
  says the session is still on-chain.

## 8. Licensing / content

The shipped surface carries no third-party asset, no vendor string and no commercial game title. The
only image is the self-generated `og-image.png`. The period look is the system font stack plus CSS
borders; the board is CSS, not a canvas or a bitmap. The vendored SDK bridge (`src/sdk/guest.mjs`) is
byte-identical to `jam-candidates/shared/guest.mjs` and contains only a code-comment GitHub URL; it
redistributes no third-party asset. There is no Wine/`pegged`/other project-name provenance string in
this project's README or docs.

## 9. Novelty (a judgement, not a measurement)

The audit classifies HANDICAP **PASSABLE** — the highest novelty grade of the three finalists. The
closest approved entries (`Chain Arena`, `ChessChuck`, `TILT!`, `Verdict`) are all *spectated,
narrated duels*; HANDICAP deals a position and prices the **exact Sprague-Grundy win/loss**, graded by
the position's branching volatility on both sides of the book, with the side chosen before the word
exists. No casino product was found for this mechanic; the mathematics is academic (Sprague-Grundy
theorem, Grundy's game, "NIM with Cash"). This is an argument about the field, not a proof — it is
carried honestly, not overstated.

## 10. UNPROVEN (corrected in Wave 3; see `docs/verification.txt` §3.8)

| claim | status |
|---|---|
| the contract's runtime on an EVM | **PROVEN on the local simulator** — deployed (block 21, `gasUsed` 471895) and 21 sessions settled with the on-chain payout equal to `model.outcome(randomness)`, 0 stuck / 0 parity failures (`docs/chain-proof.json`); production-chain runtime **UNPROVEN** |
| the embed path in the local host harness | **PROVEN** — mounted + wageredThroughHost + settled, sessions 20 -> 21 (`docs/verification.txt` §8); the production host is **EXTERNAL BLOCKED** (`docs/testnet.md`) |
| host-level replay / double-settlement / stale-session guarantees | taken from `CONTRACT_CONSTRAINTS.md`, not re-executed (production host guarantees remain UNPROVEN) |
| sandboxed-iframe behaviour | **OBSERVED in the local host harness** (the guest mounted, wagered and settled in the iframe); the production host's exact sandbox was not run |
| adversarial extreme wagers without a host | the host owns min/max; not exercised |
