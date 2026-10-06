# HANDICAP — chain integration

## Bridge copy (verified byte-identical)

```
$ sha256sum jam-candidates/shared/guest.mjs src/sdk/guest.mjs
46263af16ea64b0e1f3e118764f82e463cd58ef1925a7b3a6af33baa121e75fe  jam-candidates/shared/guest.mjs
46263af16ea64b0e1f3e118764f82e463cd58ef1925a7b3a6af33baa121e75fe  src/sdk/guest.mjs
```

Same bytes, not a re-derivation. `index.html` imports `connectGameToHost`, `observeGameContentSize`,
`computeMaxWager` and `SessionPhase` from `./sdk/guest.mjs`.

## Interface copy (verified byte-identical)

```
$ sha256sum prototype/game/contracts/ICasinoGameV2.sol contracts/ICasinoGameV2.sol
0994930bd09720f2430a968ae26934c5dd4bbf9e617462e8d15b13973f9752a4  prototype/game/contracts/ICasinoGameV2.sol
0994930bd09720f2430a968ae26934c5dd4bbf9e617462e8d15b13973f9752a4  contracts/ICasinoGameV2.sol
```

`contracts/HandicapGame.sol` implements it:

| member | HANDICAP behaviour |
|---|---|
| `quoteCaps(wager, gameData)` | `maxEscrowStake = wager`, `maxReservedProfit = wager * 80492 / 10000 - wager` (80492 bps is the highest price on either side of any tier) |
| `quoteRiskParams(wager, gameData)` | decodes the pick from `gameData` exactly as `onSessionStart` does, so the quote matches the round that will run: `maxPayout = wager * 80492 / 10000`, `expectedPayout = wager * 9500 / 10000`, and per side — FIRST: `probabilityWad = 33599853515625000` (3.36%, the 1.4068x band), `bodyVarianceScaled = wager * wager * 290760843382584294` (top tier 4 removed); SECOND: `probabilityWad = 10044097900390625` (1.0044%, the 8.0492x band), `bodyVarianceScaled = wager * wager * 2734806412979170708` (top tier 0 removed) |
| `onSessionStart(ctx)` | decodes the pick from `ctx.gameData` (1 = FIRST, 2 = SECOND), commits the full worst-case reserve, `nextPhase = WAITING_RANDOMNESS`, `requestRandomnessNow = true` |
| `onPlayerAction(ctx, actionData)` | reverts `HandicapGame__NoPlayerAction` — matches `capabilities.submitAction: false` |
| `onRandomness(ctx, randomness)` | deals the board from bits 232..255, computes the exact Grundy value and the branching factor, settles `SETTLED` with `reservedProfitDelta = 0` |
| `quoteForfeitPayout(ctx)` | `0` — the round is instant, nothing is cashable mid-flight |

`newGameState = abi.encode(uint256 board, uint256 grundy, uint256 moves, uint256 tier, uint256 pick, uint256 payout)`
— six words the page decodes with a 10-line BigInt slice, so the reveal is byte-for-byte what
settled.

## The pick is committed before the word exists

`gameData` carries the side. The host passes it at `openSession` time, and the contract reads it in
`onSessionStart` (to commit the reserve and to write `abi.encode(uint256 pick)` into
`newGameState`). `onRandomness` does **not** re-read it: it takes the side from `_committedPick(ctx)`
(`contracts/HandicapGame.sol:136-143`, called at `:202`), which decodes the word `onSessionStart`
committed. `gameData` is only a fallback there, for a context that never passed through
`onSessionStart` or whose host returned no state — the candidate's original behaviour, kept so the
payout cannot regress (`security.md`). The player's choice is therefore fixed before the VRF word is
known, which is the property the game's fairness claim rests on. `tests/evm.test.mjs` asserts both
directions on a deployed contract, including the two fallback cases.

## Embed lifecycle in the page

```
on load    : connectGameToHost({ setState }) ; connection.promise.then(api => { host = api; ... })
             catch -> enterStandalone('No host answered: running the standalone demo.')
             2.5 s timer -> if no host answered, enterStandalone(...) so the page can never hang
on setState: wallet/token/balances mirrored; betting enabled only when wallet.status === 'ready'
on BET     : host.openSession({ wager, gameData: '0x01' | '0x02' })
             then the snapshot is watched for that sessionKey to become SETTLED with a gameState
             90 s watchdog -> release the UI and say the session is still on-chain
on settle  : decodeGameState -> reveal() through the SAME render path as the demo,
             then host.revealOutcome({ sessionId }) (a failure there is swallowed: it is presentational)
on unload  : connection.destroy()
```

Iframe safety: no `localStorage`, `sessionStorage`, `IndexedDB`, `document.cookie`, `window.open`,
`alert`/`confirm`/`prompt`, `top.location`, downloads, pointer lock, or `vh`/`vw` units. Sound is
WebAudio, gesture-gated, and wrapped in `try/catch`. Results render in-page.

`?ref=chainjam` is tolerated by not reading the query string at all (the harness reports this as
INFO: "does not read the query string — ?ref=chainjam is inherently tolerated").

## Deployed and settled on the local simulator

The contract was deployed and repeatedly settled on the prescribed local environment — chain id
31337, the vendored VRF router, real ECVRV proofs. Every figure below is quoted from
`research/chain-evidence.json` and `jam-candidates/tools/chain-proof-all.json` (the `handicap`
slice, byte-identical to `docs/chain-proof.json`); the verbatim record is in `docs/verification.txt`
§3.4.

| field | value |
|---|---|
| chain id | 31337 |
| contract address | `0x8a791620dd6260079bf849dc5567adc3f2fdc318` |
| deploy tx | `0x5e7a8868a6291a81a5f8c243e8114d5c4cf194f7a0f3760dc11ee85ac9a72319` |
| deploy block | 21 |
| deploy `gasUsed` | 471895 |
| sessions settled | 21 |
| unique VRF fulfilment txs | 21 |
| re-settled round set | 20 rounds, 0 stuck, 0 parity failures |
| max-payout eth-call (`topPath`) | word `0x20804c37…57a2a2`, stat 12, mult 1.4068x, `payoutWei` 1406800000000000000, `capWei` 8049200000000000000, `withinCap` true |

Every settled payout was re-derived from the randomness the chain itself emitted
(`model.outcome(settled.randomness)`) and matched the on-chain payout exactly; the first three
rounds of the set are recorded in `docs/chain-proof.json` (`firstRounds`, all `parity: true`). The
top-payout path was exercised by `eth_call` and returned the exact top payout, inside the committed
cap. This is a real EVM, but it is **not** the production chain — production-chain deployment is
EXTERNAL BLOCKED (`docs/testnet.md`).

## Status

| claim | status |
|---|---|
| guest bridge byte-identical to `shared/` | **PROVEN** (sha256 above) |
| interface byte-identical to the prototype | **PROVEN** (sha256 above) |
| contract compiles standalone | **PROVEN** (`docs/rtp.md` records the command and bytecode) |
| contract tables match `model.mjs` band-for-band | **PROVEN** (`tests/model.test.mjs`) |
| standalone demo plays a full round in a browser | **PROVEN** (`docs/standalone.md`, `docs/preview.png`) |
| embed path in the local host harness | **PROVEN** — mounted + wageredThroughHost + settled, sessions 20 -> 21 (`docs/host-embed.json`) |
| embed path against the production Chain.wtf host | **EXTERNAL BLOCKED** — no entrant-accessible production host exists (`docs/testnet.md`) |
| contract deployed and settled on the local simulator (chain id 31337) | **PROVEN** — deploy tx + block 21 + 21 settled sessions, 0 stuck / 0 parity failures (`docs/chain-proof.json`) |
| gas of an individual *settlement* | **UNPROVEN** — the deploy `gasUsed` (471895) is recorded, but no per-settlement gas figure was captured |
