# HANDICAP — Wave 4B adversarial closeout

Hostile, independent re-test of this project's claims. Written by a reviewer who did NOT build it.
Every number below comes from a command run in this tree on 2026-09-27 or from a named evidence
file; anything not tested is marked **UNTESTED**. Scratch scripts were written under `/tmp/wave4b/`
(never inside the project); no protected file was edited.

Scope note: the coordinator-owned tools (`chain-probe.mjs`, `verify-host-embed.mjs`, the local node,
the Vite harness) and `git` were not run. The only server started was the project's own
`npm run serve` on its documented port 8921, and it was stopped in the same command.

Verdict summary:

| # | attack | verdict |
|---|--------|---------|
| 1 | exact RTP, both sides, independent enumeration | **FALSIFIED** (documented per-side figures wrong; corrected) |
| 2 | model↔contract parity, independent unpack + 2^24 brute force | NOT FALSIFIED |
| 3 | `_committedPick` (`:171` fix) divergence / stale / uninitialised | NOT FALSIFIED |
| 4 | payout cap `maxPayout <= escrowedStake + reservedProfit` | NOT FALSIFIED |
| 5 | framing / manifest / shipped-`dist/` hygiene | NOT FALSIFIED |
| 6 | doc-truth hunt | **2 claims FALSIFIED and corrected; 1 un-fixable (edit scope); others verified** |
| 7 | clean-checkout build/test/check | NOT FALSIFIED (PASS, exit 0) |
| 8 | secret scan (all files incl. `dist/`) | NOT FALSIFIED (no secrets) |

---

## Attack 1 — exact RTP for BOTH sides (independent enumeration) — **FALSIFIED**

**Method.** Wrote a Kayles row-Grundy DP from scratch (`/tmp/wave4b/rtp.mjs`, no import of any
project table or helper; `game/model.mjs` was only imported afterwards as a cross-check of
`outcome()`), enumerated all 2^18 boards, derived tier counts, recomputed each side's price with
`round(9500 * n_t / c_side_t)`, and summed the exact integer odds. Did not call `tools/enumerate.mjs`
or any project enumeration helper.

**Raw result** (`node /tmp/wave4b/rtp.mjs`, verbatim excerpts):

```
my G(0..6) = 0,1,2,3,1,4,3  (expect 0,1,2,3,1,4,3)
tier  c0      c1      n       P(first)   P(second)
0       2633   19676   22309  0.881976  0.118024
1      19053   65572   84625  0.774854  0.225146
2      17226   57936   75162  0.770815  0.229185
3      16641   50364   67005  0.751645  0.248355
4       4235    8808   13043  0.675305  0.324695
totals c0/c1/n 59788 202356 262144
model mismatches grundy/tier/moves: 0 0 0
priceFirst  10771, 12260, 12325, 12639, 14068
priceSecond 80492, 42195, 41451, 38252, 29258
exact RTP FIRST  = 9499.991058 bps
exact RTP SECOND = 9500.010906 bps
gap = 0.019848 bps
nearest integer FIRST/SECOND: 9500 9500
```

**Verdict.** The declared `EXPECTED_RTP_BPS = 9500` and the tier counts/prices are correct. The
**documented per-side figures `9499.9956` and `9500.0037` are WRONG**: the exact values are
**9499.9911 bps (FIRST)** and **9500.0109 bps (SECOND)**. This is not a matter of interpretation: the
project's own enumerator prints `94.9999% / 95.0001%`, which agree with the corrected values and not
with the documented ones, and `docs/rtp.md` already quoted `9499.9911` (the coordinator's 2^24
re-derivation) further down the same file. `game/model.mjs` was read-only and was not changed — its
*declared* constant is still 9500 and remains correct as the declaration.

**Corrections made** (recorded here as required):

| file | before | after |
|------|--------|-------|
| `README.md` (RTP table) | FIRST 9499.9956 / SECOND 9500.0037 | FIRST 9499.9911 / SECOND 9500.0109 |
| `docs/rtp.md` §1 | same, with `94.99996%` / `95.00004%` | `94.99991%` / `95.00011%` |
| `docs/rtp-proof.md` §2.4 | FIRST 9499.9956 / SECOND 9500.0037 | FIRST 9499.9911 / SECOND 9500.0109 |
| `docs/build-report.md` RTP table | FIRST 9499.9956 / SECOND 9500.0037 | FIRST 9499.9911 / SECOND 9500.0109 |

`game/README.md:103-104` carries the same wrong figures. It is **not** in the permitted edit set
(`README.md` + `docs/**` only), so it was **not** corrected — see §"Un-fixable". Note that
`game/README.md` is copied into the shipped `dist/game/README.md`, so the wrong numbers are also
present in the shipped tree until that file is fixed by whoever owns it.

**Per-tier fairness (the "individually fair" sub-claim).** EV per `(tier, side)` cell, from the same
run:

```
tier 0: EV(FIRST)=9499.762  EV(SECOND)=9499.997
tier 1: EV(FIRST)=9499.707  EV(SECOND)=9500.045
tier 2: EV(FIRST)=9500.295  EV(SECOND)=9499.946
tier 3: EV(FIRST)=9500.046  EV(SECOND)=9500.060
tier 4: EV(FIRST)=9500.187  EV(SECOND)=9499.933
```

Each cell is within **0.30 bps** of 9500 (both sides' deviation ≤ 0.295 bps), and the two sides of a
tier agree to within **0.36 bps**. The claim "the same expected value in every tier" therefore holds
*to integer-bps rounding*, not exactly — the price is an integer bps so exact equality is impossible
in general. **NOT FALSIFIED but imprecise**; the honest phrasing is "equal within ≤0.36 bps".

---

## Attack 2 — model↔contract parity (independent unpack + brute force) — NOT FALSIFIED

**Method.** Parsed the contract's `ROW_G_PACKED`, `ROW_MOVES_PACKED`, `PRICE_FIRST_PACKED`,
`PRICE_SECOND_PACKED` out of `contracts/HandicapGame.sol`, unpacked every nibble/word independently,
compared to my own from-scratch tables, then re-implemented `_board()`/`_grundyAndMoves()`/`_tier()`
in BigInt and brute-forced **all 2^24 top-bit words** against `model.outcome()`.

**Raw result** (`node /tmp/wave4b/parity.mjs`, `parity2.mjs`):

```
ROW_G unpack mismatches: 0  ROW_MOVES unpack mismatches: 0
contract PRICE_FIRST unpack  10771, 12260, 12325, 12639, 14068
contract PRICE_SECOND unpack 80492, 42195, 41451, 38252, 29258
price first equal: true   price second equal: true
MAX_PRICE_BPS 80492 largest packed field 80492 equal: true
brute force over 2^24 top-bit words: mismatches = 0
tier | model.priceFirstBps vs contract | model.priceSecondBps vs contract
0 | 10771 vs 10771 ok | 80492 vs 80492 ok      ... all five tiers ok
price-field mismatches: 0
```

**What was checked:** board decode mask `(randomness >> 232) & 0x3ffff` for every 24-bit value; all 64
row-Grundy nibbles; all 64 row-move nibbles; all 10 price fields; the four tier thresholds `19/14/11/7`;
and the model's `priceFirstBps`/`priceSecondBps` per tier. Payout is the same integer expression
`wager*price/10000` on both sides.

**Verdict.** Could **not** construct any 24-bit board where the contract's Grundy, branching factor,
tier or price differs from the model. **NOT FALSIFIED.** (The *deployed* instance was not exercised —
running the local node is out of scope — so this is source-level parity only; runtime parity on an EVM
is **UNTESTED by this wave**, and is asserted elsewhere from `docs/chain-proof.json`.)

---

## Attack 3 — the `:171` fix (`_committedPick`) — NOT FALSIFIED

**Method.** Read `_committedPick` / `_pick` / `onSessionStart` / `onRandomness`; re-implemented the
decision logic in JS (explicitly a re-implementation, not the EVM) and fed it the host-lifecycle cases
plus adversarial cases.

**Raw result** (`node /tmp/wave4b/parity3.mjs`):

```
commit=1, gameData=1 (normal)             -> 1
commit=2, gameData=2 (normal)             -> 2
HOSTILE commit=1, gameData=2              -> 1     (committed state wins)
HOSTILE commit=2, gameData=1              -> 2     (committed state wins)
commit=1, gameData empty                  -> 1
no state, gameData=2 (fallback)           -> 2
0-length state, gameData=1                -> 1
31-byte state (length!=32)                -> 2
state encodes 0 (fallback)                -> 2
state encodes 2^256-1 (fallback)          -> 1
```

**Findings.** (a) Under the host lifecycle (`onSessionStart` writes `abi.encode(uint256(pick))`) the
committed `gameState` is exactly 32 bytes and encodes 1 or 2, so it is authoritative and `gameData` is
ignored — no divergence. (b) The fallback triggers only when `gameState.length != 32` or the decoded
value is not 1/2; that is the pre-fix behaviour, so no regression. (c) There is no uninitialised read:
`gameState` is calldata and the `length == 32` guard is checked first; a zero-length state falls to the
fallback. A *stale* value is not reachable inside the contract either — it would require the host to
feed a different session's `gameState`, which is host-trusted, not a contract defect.

**Integration note (not a divergence).** `_pick` reads `gameData[0]` and reverts `BadPick` unless it is
exactly `0x01`/`0x02`; the page sends `'0x01'`/`'0x02'`. If a host ever ABI-encoded the pick as a
32-byte `uint256`, byte 0 would be `0x00` and `onSessionStart` would revert. This matches the shipped
page, so it is consistent today; it is a strictness to keep in mind for any host integration.

**Verdict.** No state was found where the `gameData` fallback and the `gameState` commitment diverge,
and no uninitialised/stale read is reachable within the contract. **NOT FALSIFIED.**

---

## Attack 4 — payout cap — NOT FALSIFIED

**Method.** Inspected `quoteCaps`, `quoteRiskParams`, `onSessionStart`, `onRandomness`, `_payout`, and
`MAX_PRICE_BPS`, then evaluated the cap identity in BigInt for representative wagers.

**Raw result** (`node -e`, verbatim):

```
wager 1                               maxPayout 8      escrow+reserved 8      equal true
wager 1000000000000000000             maxPayout 8049200000000000000  escrow+reserved 8049200000000000000  equal true
wager 123456789012345678901234567890  maxPayout 993728386118172838611817283860  escrow+reserved 993728386118172838611817283860  equal true
```

**Findings.** `escrowedStake + reservedProfit = escrowedStake + (escrowedStake*80492/10000 -
escrowedStake) = escrowedStake*80492/10000 = maxPayout`. The reserve is computed from the **global**
`MAX_PRICE_BPS = 80492` (the largest field on either side, verified in Attack 2), independent of tier
and side, so **no tier or side can break it**: every tier/side price ≤ 80492, and `_payout` floors.
The only residual assumption is `ctx.wagerBase == ctx.escrowedStake` at settle time (the reserve is
committed on `escrowedStake`, the payout is paid on `wagerBase`); the contract does not itself enforce
that equality, but both are host-supplied and `quoteCaps`/`quoteRiskParams` take a single `wager`.
Noted as host-trust, not a falsification. Integer overflow is reachable only at astronomically large
wagers (documented in `docs/security.md` §5).

**Verdict.** `maxPayout == escrowedStake + reservedProfit` structurally, exactly, for every wager
tested. **NOT FALSIFIED.**

---

## Attack 5 — framing / manifest / shipped-`dist/` hygiene — NOT FALSIFIED

**Method.** Inspected the shipped `dist/` tree only (byte-compared to the sources first), then served
it with the project's own `npm run serve` (port 8921, stopped afterwards) and read the response
headers.

**Raw results:**

```
build parity: dist/{index.html,game/model.mjs,game/README.md,src/app.js,src/styles.css,src/sdk/guest.mjs}
              == sources; dist/{_headers,vercel.json,game.manifest.json,og-image.png} == public/*
manifest: valid JSON; gameId=HandicapGame apiVersion=1 mode=full-iframe
          openSession=true submitAction=false assets={iconUrl,coverUrl}=og-image.png
framing blockers: none (only the literal string "X-Frame-Options" inside a comment in dist/_headers)
root-relative asset paths (href|src="/): none
storage/cookie/window.open/serviceWorker: none
vh/vw units: none
absolute URLs in dist: only https://jam.chain.wtf/widget.js (the one required third-party script)
                       and a github.com URL inside a guest.mjs code comment
localhost / 127.0.0.1 / file:// / /home/ : none
<script> tags in dist/index.html: ./src/app.js (module) and https://jam.chain.wtf/widget.js (async)  = exactly one 3rd-party
served headers: / text/html, /src/app.js + /game/model.mjs text/javascript, /src/styles.css text/css,
                /game.manifest.json application/json, /og-image.png image/png; no X-Frame-Options, no CSP
traversal probe /%2e%2e/etc/passwd -> 404; /../etc/passwd -> 404
```

**Verdict.** No framing blocker in any shipped host config; no root-relative asset path; no
storage/cookie/`window.open`/service worker; no `vh`/`vw`; exactly one third-party script (the
widget); no filesystem/`localhost` path; the manifest is valid JSON with the required fields. All
**NOT FALSIFIED**. (The checklist asked only about the shipped `dist/`; the committed `dist/` is
byte-identical to a fresh `npm run build` — see Attack 7.)

---

## Attack 6 — doc-truth hunt

At least six numeric/factual claims were chased against the actual files/evidence.

| claim (source) | test | result |
|---|---|---|
| per-side exact RTP `9499.9956` / `9500.0037` (`README.md`, `docs/rtp.md`, `docs/rtp-proof.md`, `docs/build-report.md`, `game/README.md`) | independent enumeration (Attack 1) | **WRONG** → corrected to `9499.9911` / `9500.0109` where in scope |
| `npm test` runs "the model tests (node --test tests/model.test.mjs)" (`README.md:63`) | `package.json` `"test"` | **WRONG** — runs both `tests/model.test.mjs` and `tests/contract.test.mjs` → corrected |
| payline table `P(FIRST)` / prices / branching (`README.md`, `game/README.md`, `docs/*`) | independent enumeration | correct (0.8820/0.7749/0.7708/0.7516/0.6753; prices 10771…14068 / 80492…29258) |
| `P ≈ 0.772 overall` (`README.md`) | enumeration | correct: 202356/262144 = 0.771926 |
| declared RTP `9500` bps / "both sides measure 9500" (`README.md`) | enumeration | correct as a rounded declaration; the components are as corrected above |
| contract bytecode `2561 B creation / 2533 B runtime` (opt 200) and `4068 B` unoptimized (`README.md`, `docs/rtp.md`, `docs/security.md`) | `solc 0.8.34 --optimize --optimize-runs 200` / plain | **exactly verified**: 2561 / 2533 / 4068 |
| vendored bridge sha256 `46263af1…e75fe` (`README.md`, `docs/architecture.md`, `docs/chain-integration.md`) | `sha256sum src/sdk/guest.mjs` | verified exact |
| interface byte-identical to prototype (`docs/chain-integration.md`, sha `0994930b…` ) | `sha256sum contracts/ICasinoGameV2.sol` | verified exact (`0994930bd0…9752a4`) |
| `og-image.png` is a self-generated 1200×630 PNG (`README.md`, `game/README.md`, `docs/build-report.md`) | PNG header parse | verified: 1200×630, depth 8, colour type 2, 15241 B; identical across `og-image.png`, `public/`, `dist/` |
| no `ico|bmp|exe|wasm|ttf|otf|woff|mp3|wav|svg|jpg` assets (`README.md`) | `find` | verified: none |
| "no runtime dependencies … no `npm install`" (`README.md`) | `package.json` | verified: zero `dependencies`/`devDependencies`; clean checkout built+tests with no `node_modules` |
| public production URL serves the page + manifest with the stated headers (`README.md`, `docs/standalone.md`) | `curl` + fetch of `https://chain-jam-handicap.vercel.app` | verified: `/` 200 `text/html`, `/game/model.mjs` + `/src/app.js` 200 `application/javascript`, `/game.manifest.json` 200 `application/json` + `access-control-allow-origin: *`; no `x-frame-options`/CSP; widget badge present; a real fetch rendered a settled round (`PAID 1.2260x — FIRST WINS`) |
| `dist/` is gitignored (`README.md` layout) | `.gitignore` | verified: `dist/` and `node_modules/` |

Claims that could **not** be tested here:

- Vercel deployment id `dpl_DWwxBWquMpkygHfZYkGC7wpv2rXV` — not observable over HTTP. **UNTESTED.**
- Contract deployment/dev-chain facts (address `0x8a79…c318`, deploy tx `0x5e7a…2319`, block 21,
  `gasUsed` 471895, 21 settled sessions, 21 unique VRF fulfilments, `0/0` stuck/parity) — require the
  local node / coordinator evidence, out of scope. Cross-checked only for internal consistency
  (`docs/chain-proof.json` states `rounds: 20`, `vrfFulfilmentTxs` lists 3; `docs/verification.txt`
  explains 21 settled sessions vs a 20-round re-settled set from `research/chain-evidence.json`).
  **UNTESTED by this wave.**
- `docs/rtp-proof.md` §3 quotes a harness run (`check 11 = 9506 bps`, `check 12 = 9496 vs 9501`) that is
  not the run recorded in `docs/verification.txt` (`9499 bps`; `9502 vs 9497`). These checks are Monte
  Carlo and vary by design (`rtp.md` itself says "observed 9495..9506"), so this is a **citation
  inconsistency, not a false claim** — the quoted 9506 line does not appear in the referenced file.
  Left as-is; flagged here.
- Host-embed / production-host / sound / narrow-viewport / production-chain claims — **UNTESTED**.

**Un-fixable wrong claim (edit scope).** `game/README.md:103-104` states
`RTP_backing_FIRST = … = 9499.9956 bps` and `RTP_backing_SECOND = … = 9500.0037 bps`. These are the
same proven-wrong figures. The Wave-4B edit authority covers `README.md` and `docs/**` only, so this
file was left untouched; it is also copied to the shipped `dist/game/README.md`. **Action for the
coordinator: correct `game/README.md` to `9499.9911` / `9500.0109`.**

---

## Attack 7 — clean-checkout repo readiness — NOT FALSIFIED

**Method.** Copied the project to `/tmp/clean-02-handicap` excluding `dist/`, `node_modules/`, `.git/`,
then ran `npm run build && npm test && npm run check` with no install step. The committed `dist/` was
also diffed against the fresh build.

**Result.** `EXIT=0`. 24/24 tests pass, 13 files parse, `dist/` rebuilt byte-identically. No
`node_modules` and no install step were needed (zero dependencies). The verbatim transcript is appended
to `docs/verification.txt` under "WAVE 4 — ADVERSARIAL CLOSEOUT + CLEAN CHECKOUT".

**Verdict.** The repo is clean-checkout ready. **NOT FALSIFIED.**

---

## Attack 8 — secret scan (every file, including `dist/`) — NOT FALSIFIED

**Method.** Keyword scan for private keys / mnemonics / seed phrases / API keys / tokens / bearer
tokens / known anvil test keys; then extracted and classified **every** 64-hex (32-byte) string in
every non-`node_modules`, non-`.git` file.

**Raw results.**

```
secret-ish keywords: only docs/testnet.md:74 "No server code, no environment variables, no secrets are required" (a negation)
known anvil/hardhat test private keys: absent
64-hex occurrences: 32, all classified:
  - tx hashes (public, local simulator chain id 31337)
  - VRF randomness / requestIds (public, local simulator)
  - sha256 file checksums of src/sdk/guest.mjs and contracts/ICasinoGameV2.sol (documented, re-verified in Attack 6)
no 64-hex string appears in any file under dist/
40-hex: the public deploy account 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 (standard anvil account 0,
  public knowledge) and VRF/word values in evidence JSON
```

**Verdict.** No private key, mnemonic, API key, bearer token or other live secret is present. Every
64-hex string is a public transaction/randomness/requestId value or a documented sha256 file hash.
**NOT FALSIFIED.**

---

## Un-fixable / UNTESTED (honest list)

- `game/README.md:103-104` — wrong RTP component figures; outside the permitted edit set.
  **RESOLVED (coordinator, 2026-09-27):** corrected to FIRST `9499.9911` / SECOND `9500.0109`
  (independently re-enumerated by the coordinator, and matching the project's own
  `npm run enumerate` output of `94.9999% / 95.0001%`).
- `docs/rtp-proof.md` §3 harness-run citation (`9506`/`9496`) not matching `docs/verification.txt`
  (`9499`/`9502`) — Monte Carlo variance plus a stale citation; not a false claim. **Not changed.**
- Deployed-contract runtime, host-embed against the production host, production-chain deployment,
  sound, narrow-viewport, per-settlement gas — **UNTESTED** (out of scope / no environment).
- 24-bit board parity is source-level; no EVM was executed here.

## Coordinator correction (2026-09-27) — `makeRng` comment wording

The model's `makeRng` and `fmix32` doc comments (and `game/README.md`, `docs/vrf.md`, `docs/rtp.md`)
claimed the seeder was **provably injective in `(lo, hi)`, hence collision-free for every round**.
That is **not proven** — the argument needs all eight lanes to separate `(lo, hi)` jointly, which is
not shown; no collision was found in any swept window, but that is a cross-check, not a proof. The
wording was corrected to the provable statement — injective in `lo` for a fixed `hi`, hence
injective within each 2^32-round window — comment-only, identically in `game/model.mjs` and
`jam-candidates/handicap/model.mjs` (no code line changed; no verified RTP affected).
