# HANDICAP

**Back the winner of an impartial position you are dealt, under perfect play.**

One VRF word deals an 18-socket board (3 rows × 6 columns). A filled socket is a pin. The position
is **Kayles**, the classic impartial pin game (octal game `.77`): on your turn you knock down one
pin, or two adjacent pins inside a row, and the player who cannot move loses. A row's Grundy value
depends only on its own 6-bit pattern, so the whole position is the disjoint sum of the three row
games and its Sprague-Grundy value is the XOR of the three row values:

```
g != 0   FIRST wins under perfect play
g == 0   SECOND wins under perfect play
```

The player backs FIRST or SECOND **before the deal**. The winner is a pure function of the word,
so the contract settles the moment the word exists: no simulation, no bounded search, and nothing
the page can draw that the chain did not already decide.

- **Declared RTP `9500` bps (95.0000%), exact by enumeration** of all 2^18 boards — not a Monte
  Carlo estimate. `tools/enumerate.mjs` proves it; both sides of the book measure 9500 bps.
- **The money is decided in `contracts/HandicapGame.sol`**, a `pure` `ICasinoGameV2` implementation.
  The browser is presentation only; it cannot change a payout. See `docs/architecture.md`.
- Exhaustive RTP proof: `docs/rtp-proof.md`. Mechanic and payline: `game/README.md`.

## Project layout

```
02-handicap/
  index.html                 the servable page (markup + asset tags only)
  game/
    model.mjs                THE deterministic model: outcome() + paytable (single source of truth)
    README.md                the mechanic, the payline, the VRF mapping, the RTP class
  src/
    app.js                   the frontend app (framework-free; extracted from the inline script)
    styles.css               the chrome (extracted from the inline style block)
    sdk/guest.mjs            the Chain guest bridge, byte-identical to jam-candidates/shared/guest.mjs
  contracts/
    HandicapGame.sol         the ICasinoGameV2 implementation (THE paytable, on-chain)
    ICasinoGameV2.sol        the host interface
  public/
    game.manifest.json       the host manifest, relative asset paths
    og-image.png             the self-generated 1200×630 cover
    _headers, vercel.json    static-host headers (CORS on the manifest only; no framing blocker)
  tests/model.test.mjs       13 model + contract-parity tests
  tools/
    build.mjs                assemble dist/ (plain copy, no bundler)
    check.mjs                node --check every .js/.mjs
    enumerate.mjs            the exhaustive RTP proof over 2^18 boards
    serve.mjs                zero-dependency static server (port 8921)
    browser-check.mjs        drives the built page over the DevTools Protocol
  docs/                      architecture, rtp, rtp-proof, vrf, chain-integration, standalone,
                             iframe, testnet, security, verification.txt, evidence artefacts
  dist/                      BUILD OUTPUT (gitignored), produced by `npm run build`
```

## Build, run, test

No runtime dependencies. Node >= 20. All scripts are plain `node`, no bundler, no `npm install`.

```sh
npm run build       # assemble dist/ by copying index.html, game/, src/ and public/*
npm test            # run the model + contract tests (node --test tests/model.test.mjs tests/contract.test.mjs)
npm run check       # node --check on every .js/.mjs in the project
npm run enumerate   # the exhaustive RTP proof over all 2^18 boards
npm run serve       # serve dist/ on http://127.0.0.1:8921/
```

The page is a `<script type="module">` that imports `./game/model.mjs`; module fetches from
`file://` are blocked, so it must be **served over http**, never opened from disk. `npm run serve`
serves the built `dist/` tree; the relative layout it expects is preserved by the build
(`index.html` → `./src/app.js` → `../game/model.mjs` and `./sdk/guest.mjs`; `og:image` →
`og-image.png` at the dist root).

To drive the built page in a real headless browser:

```sh
npm run build
npm run serve &                       # http://127.0.0.1:8921/
node tools/browser-check.mjs          # loads, picks SECOND, DEALs, reads the settled round, DEALs again
```

## The payline — a two-sided book, not a coin flip

A flat price on a binary winner would be a coin flip with one number. The board's **branching
factor** — its legal-move count, `sum over runs of (2L-1)` — is bucketed into five volatility
tiers, and each tier quotes **its own price on each side**:

| tier | branching | P(FIRST wins) | price FIRST | price SECOND |
|------|-----------|---------------|-------------|--------------|
| 0 | 19..33 | 0.8820 | 1.0771× | 8.0492× |
| 1 | 14..18 | 0.7749 | 1.2260× | 4.2195× |
| 2 | 11..13 | 0.7708 | 1.2325× | 4.1451× |
| 3 | 7..10 | 0.7516 | 1.2639× | 3.8252× |
| 4 | 0..6 | 0.6753 | 1.4068× | 2.9258× |

Each price is the **fair price for that tier**, `price = 9500 / P(that side wins | tier)`, so both
sides return the same expected value **in every tier**, not merely on average. The position family
favours the first player (P ≈ 0.772 overall), so FIRST is the short side and SECOND is the long
side: the pick is a choice of variance, not of edge, exactly as a real two-sided handicap book
behaves.

## RTP

`EXPECTED_RTP_BPS = 9500`. The VRF word space is 2^256, but `outcome()` reads only bits 232..255 —
the board — and every one of the 2^18 boards is equally likely, so the position distribution is
**exactly uniform on a finite set** and the RTP is an exact weighted sum of integer odds:

| side | exact RTP over 2^18 boards | declared |
|------|----------------------------|----------|
| backing FIRST | 9499.9911 bps | 9500 |
| backing SECOND | 9500.0109 bps | 9500 |
| gap | 0.02 bps | — |

Full derivation, the independent second DP, and the Wave-3 C1 post-mortem: `docs/rtp-proof.md`.

## The contract

`contracts/HandicapGame.sol` implements all six `ICasinoGameV2` functions, has no constructor, and
holds the same integer tables as `game/model.mjs` (packed into `uint256`s), so the paytable is
band-for-band identical rather than merely re-derived. It settles on the **exact** Sprague-Grundy
value: `onRandomness` deals the board from bits 232..255, computes the Grundy value and the
branching factor with two packed table lookups, prices the committed side, and returns
`SETTLED` with `reservedProfitDelta = 0`.

Compile it standalone (needs `solc` 0.8.34 and `ICasinoGameV2.sol` beside it):

```sh
cd contracts && solc --optimize --optimize-runs 200 --bin --bin-runtime HandicapGame.sol
# 2561 B creation / 2533 B runtime (optimized, 200 runs)
```

The committed side is written to `gameState` at `onSessionStart` and read back at `onRandomness`
(the `_committedPick` path), with `gameData` only as a fallback — so the side that settles is the
side that was locked in before the word existed. See `docs/security.md` (finding S2, fixed).

## Where this lives

| | |
|---|---|
| repository | **https://github.com/symulacr/chain-jam-handicap** |
| branch | `master` |
| jam status | **approved**, submitted 2026-09-27, live in the jam gallery |
| public build | https://chain-jam-handicap.vercel.app |

Pushed and current on `master`. Paths like `research/…`, `jam-candidates/…` and `vendor/…` cited
in the docs below are relative to the parent monorepo, not to this repository; a clean clone of
this repo builds and tests on its own.

## Sound

WebAudio oscillators only — **no audio file ships**, matching the entry's content rules. Backing a
side ticks once (and only on a real change, never on boot); settling plays a rising tone when the
wager pays and a low one when it does not. The settle tone keys off `mk > 0`, the payout, rather
than `won`, so what you hear and what the slip says cannot disagree if the paytable ever changes. A
silent flag keeps the boot round quiet. The titlebar carries a mute button (`#mute`, a real
`<button>` with `aria-pressed`) that stops every later cue without touching the round in flight.
Driven in a real headless browser: one oscillator per deal across paying and losing rounds, zero
while muted, and zero on boot.

## Public deployment

The page is a static tree. Build it, then deploy **`dist/`** to any static host (Netlify, Cloudflare
Pages, Vercel, GitHub Pages). The manifest is served at `{gameUrl}/game.manifest.json` with CORS
(`public/_headers`, `public/vercel.json`), both of which deliberately set **no framing blocker**
(the page must stay embeddable inside the Chain host). No server code, no environment variables.

The public production URL for this entry is **https://chain-jam-handicap.vercel.app** (Vercel,
deployment `dpl_DWwxBWquMpkygHfZYkGC7wpv2rXV`), verified externally (`text/html`, the `.mjs` assets as
a JavaScript MIME, `application/json` + CORS on the manifest, no framing header, widget tag present)
and driven standalone in a real headless browser. See `research/public-deploy-top3.md`.

Real-chain execution was proven on the prescribed **local simulator** (chain id 31337) with the real
vendored VRF router and real ECVRV proofs: `HandicapGame` deployed (tx
`0x5e7a8868a6291a81a5f8c243e8114d5c4cf194f7a0f3760dc11ee85ac9a72319`, block 21, gasUsed 471895) and
settled 21 sessions with 21 unique VRF fulfilments, 0 stuck, 0 parity failures. **There is no public
testnet path for an entrant**; production-chain deployment and the production Chain.wtf host are
marked **EXTERNAL BLOCKED**, not faked. See `docs/testnet.md`, `EXTERNAL-CHAINWTF-LIMITATION.md`.

## Honest limitations

- **The embedded (host) path is proven against the SDK's production-faithful host harness**, not
  against the live production Chain host. In `vendor/casino-sdk/simulator` the guest mounted, a wager
  was placed **through the bridge**, and the settled reveal was read from the guest's own DOM (session
  62; sessions 20 → 21). The live Chain host remains `EXTERNAL BLOCKED`.
  See `docs/verification.txt` §8 (the run record) and `research/host-embed-report.json` in the parent monorepo.
- **The contract's runtime is proven on the local simulator** (chain id 31337): 21 settled sessions,
  the side that settled was the side locked in `gameState`, 0 parity failures. Per-settlement gas is
  still not measured (only the deploy `gasUsed` 471895 is). See `docs/verification.txt`.
- **The game has no decision after the wager.** The pick is committed before the deal and the winner
  is then determined; the graded payline is the spread. This is recorded, not hidden.
- **Sound and narrow-viewport layout were not exercised** (headless Chrome has no audio device; a
  desktop viewport was driven).
- **The novelty claim** ("backing the winner of a position you are dealt, under perfect play") is an
  argument about the field, not a measurement. See the audit referenced in `docs/security.md`.
- `docs/verification.txt` records exactly what was and was not run.

## Forbidden-content position

No vendor product names or brands, no commercial game titles, no font/audio/`ico`/`bmp`/`exe`/`wasm`
files, no third-party images. The only image is the self-generated `og-image.png`. The period look is
the system font stack plus CSS borders; the board is CSS, not a canvas or a bitmap.

## License

MIT. See `LICENSE`. The contract carries `SPDX-License-Identifier: MIT`.
