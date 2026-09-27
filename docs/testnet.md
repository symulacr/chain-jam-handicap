# HANDICAP — testnet / deployment finding

**Production-chain deployment: EXTERNAL BLOCKED.** No public testnet path exists for an entrant
into this jam. This document records the finding and its evidence, and states the strongest
permitted substitute that was actually executed. It is not faked.

## The finding

`research/wave-final-real-chain-plan.md` establishes, with citations, that **no public testnet path
exists for an entrant**:

1. A Base Sepolia router address does appear in a simulator **test** file
   (`simulator/src/randomness-verification.test.ts:30-31`, chain id 84532). It is **not** the SDK's
   vendored router build, and it exposes **no** `requestRandomness` / `fulfillRandomness`.
2. **No public `CasinoGameFacet` diamond exists on any chain.** The facet that provides the
   `openSession` / settle entrypoints the game calls is not deployed anywhere an entrant can reach.
3. The SDK's own getting-started document is explicit:
   - `vendor/casino-sdk/docs/GETTING_STARTED.md:4` — *"No Chain.wtf account, backend access, or
     testnet funds are needed."*
   - `vendor/casino-sdk/docs/GETTING_STARTED.md:178-179` — the whitelist, the indexer and the
     catalog are *"wired by the Chain.wtf maintainers"*, i.e. they are not entrant-provisionable.

Consequently the **local simulator on chain id 31337 is the only entrant-accessible environment**,
and the jam's own gate is *"Runs correctly in the local simulator"*. There is no public network on
which this game can be deployed and settled by an entrant today.

## The strongest permitted substitute (what was actually executed)

Real-chain execution was proven on the **prescribed local environment** — chain id 31337, the real
vendored VRF router, and real ECVRV proofs — by the coordinator's own independent re-derivation
(candidate phase, and freshly again in Wave 3):

- the contract was **deployed and settled** on the local *Chain* environment with a deployment tx
  and settled sessions, **0 stuck, 0 parity failures**. The Wave-3 run records deploy tx
  `0x5e7a8868a6291a81a5f8c243e8114d5c4cf194f7a0f3760dc11ee85ac9a72319`, block 21, `gasUsed` 471895,
  21 sessions settled and 21 unique VRF fulfilment txs (`research/chain-evidence.json`);
- the payout was verified against **the randomness the chain itself emitted**
  (`model.outcome(settled.randomness)`);
- a maximum-payout-path proof by `eth_call` confirmed the exact top payout and
  `payout <= escrowedStake + reservedProfit`;
- the harness re-derived the candidate's RTP from a CSPRNG the candidate does not control
  (`verify-candidate.mjs` check 11; see `rtp.md`).

The local evidence artefacts are `docs/chain-proof.json` (deployment + settled-session proof) and
`docs/chain-integration.md` (the interface/lifecycle mapping). The candidate's per-session settled
payloads are exercised by the model tests.

## What this build did and did not do

| item | status |
|---|---|
| compile the contract standalone (`solc` 0.8.34) | **DONE** — 2561 B creation / 2533 B runtime |
| prove the paytable band-for-band against `game/model.mjs` | **DONE** — `npm test` |
| reproduce the exact RTP by enumeration | **DONE** — `npm run enumerate` |
| run the game in the local simulator (chain id 31337) | **PROVEN** — deployed at block 21 (`gasUsed` 471895) and settled 21 sessions, 0 stuck / 0 parity failures, plus a max-payout eth-call; fresh Wave-3 evidence in `docs/verification.txt` §3.4 and `docs/chain-proof.json` |
| deploy to a public testnet | **EXTERNAL BLOCKED** — no entrant-accessible network exists |
| deploy to the chain.wtf production host | **EXTERNAL BLOCKED** — whitelist/indexer/catalog are maintainer-wired |

## Deployment notes for whoever *can* deploy

If a public deployment path is ever opened, the artefact is the static tree assembled by
`npm run build`:

1. Deploy **`dist/`** to any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages).
2. Ensure `{gameUrl}/game.manifest.json` is served as `application/json` **with CORS**
   (`public/_headers` / `public/vercel.json` provide this) — the host page fetches it cross-origin
   before validating the game.
3. Set **no framing blocker**: no `X-Frame-Options`, and no CSP `frame-ancestors` that excludes
   `*.chain.wtf`. The page must stay embeddable.
4. Do not add a catch-all `/* -> /index.html 200` rewrite: it would swallow the manifest and the
   sibling `.mjs` loads.
5. The game then needs to be whitelisted, indexed and catalogued by the maintainers (see finding 3).

No server code, no environment variables, no secrets are required to serve the page.
