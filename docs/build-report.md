# HANDICAP — prototype results

Deliverable status for the Wave 6 build. Everything claimed here is either recorded in a file under
`docs/` or marked **UNPROVEN**.

> Historical note (Wave 3B, 2026-09-27): this document records the **candidate** build. Its file
> layout, LOC and weight tables describe the pre-restructure candidate, which `docs/verification.txt`
> supersedes. The "Unproven" table at the end has been corrected in place; the current verified state
> is the Wave 3 section of `docs/verification.txt` (§3.8).

## Deliverables

| file | LOC | notes |
|---|---|---|
| `index.html` | 575 | the whole page: inlined CSS + JS, no build step, no bundler, no `package.json` |
| `model.mjs` | 281 | the single source of truth; exports exactly `SLUG, BANDS, EXPECTED_RTP_BPS, bandOf, outcome, makeRng` |
| `contracts/HandicapGame.sol` | 190 | `ICasinoGameV2`; same integer tables as `model.mjs` |
| `contracts/ICasinoGameV2.sol` | — | copied byte-identically from the prototype (`docs/chain-integration.md`) |
| `sdk/guest.mjs` | — | copied byte-identically from `jam-candidates/shared/` |
| `game.manifest.json` | 34 lines | `presentation.mode: full-iframe`, `hostPanels` all false, `openSession: true`, relative `assets` |
| `tests/model.test.mjs` | 235 | 13 tests, 0 failures |
| `tools/enumerate.mjs` | 137 | exhaustive RTP proof over 2^18 boards + the word->board parity check |
| `rtp-proof.md` | 177 | declared RTP, derivation, cross-checks, C1 defect history |
| `README.md` | 112 | what it is, how to run, honest limits |
| `docs/*.md` | 490 | architecture, chain integration, VRF, RTP, standalone, iframe, this file |
| `og-image.png` | — | self-generated 1200x630 PNG |
| `docs/preview.png` | — | screenshot of a dealt standalone round |

## Weight

| measure | value |
|---|---|
| page: `index.html` + `model.mjs` (all hand-written) | 35,716 B raw / 12,168 B gzip |
| page as the harness measures it (also includes the vendored `sdk/guest.mjs`) | **62,552 B raw / 18,939 B gzip** (`docs/verification.txt`, INFO line 14) |
| contract creation bytecode | **2,452 B** (optimized, 200 runs) |
| contract runtime bytecode | **2,424 B** |
| contract creation bytecode, unoptimized | 3,919 B |
| `og-image.png` | 15,241 B, independently verified 1200x630 RGB |

## RTP

| | value | how derived |
|---|---|---|
| declared `EXPECTED_RTP_BPS` | **9500** | — |
| exact, backing FIRST | 9499.9911 bps | enumeration of all 2^18 boards |
| exact, backing SECOND | 9500.0109 bps | enumeration of all 2^18 boards |
| harness truth measurement | 9497 bps ± 7 bps | 2,000,000 `crypto.randomBytes` words the candidate does not control |
| harness sampler measurement | 9506 vs 9497 bps (diff 8, allowed 60) | candidate's `makeRng` vs an independent CSPRNG, rounds from 5,000,000 |

Both sides of the book land on the same integer because the price in each tier is
`round(9500 * n_tier / winning_boards_in_tier)` on both sides — so the aggregate is 9500 by
construction for any counts covering the board space and is not itself evidence. The enumeration's
content is the tier counts and the per-tier return, every cell of which is within 0.295 bps of
9500. Full derivation: `rtp-proof.md` §2.4.

## Harness

```
$ node jam-candidates/tools/verify-candidate.mjs top3/02-handicap
  [PASS]  1 structure     5 required files present
  [PASS]  2 syntax        4 JS files parse
  [PASS]  3 manifest      valid (gameId=HandicapGame, mode=full-iframe)
  [PASS]  4 widget tag    widget tag present; page loads the verified model
  [PASS]  5 hygiene       20 files; 2 self-generated image(s); 0 banned strings; 0 third-party binaries
  [PASS]  6 framing       no framing blocker in any host config
  [INFO]  7 ref param     does not read the query string — ?ref=chainjam is inherently tolerated
  [INFO]  8 og:image      og:image present: og-image.png
  [PASS]  9 model loads   SLUG=handicap, declared 9500 bps
  [PASS] 10 paytable      6 bands, 0..15, monotonic, boundaries exact
  [PASS] 11 rtp truth     9500 bps measured vs 9500 declared (CI +/-7 bps), stat 0..12
  [PASS] 12 rtp sampler   9497 bps via makeRng vs 9494 bps independent CSPRNG (diff 3 bps, allowed 60)
  [PASS] 13 key space     700,000 round indices across 7 magnitude windows, 0 collisions
  [INFO] 14 weight        20 files; page 62,552 B raw / 18,939 B gzip
  => PASS
```

Exit code 0. The full verbatim transcript is `docs/verification.txt`. Checks 11 and 12 are Monte
Carlo comparisons, so the measured numbers move by a few bps from run to run (observed across runs:
9495..9506 for check 11, diffs of 1..8 bps for check 12); the exact declared value is 9500, which is
what `rtp-proof.md` derives by enumeration.

Note: an earlier run failed check 5 because the harness had written its own previous failure detail
(a line that itself contained a banned product name) into `docs/verification.json`, and then
re-scanned that file on the next run. The stale generated file was deleted and the declaration in
`README.md` reworded; the run above is after both fixes. Lesson recorded here because the same trap
fires twice: any artefact that quotes a scanner's own verdict can re-poison the next scan.

## What was run, and what was seen

| run | result |
|---|---|
| `node --check` on every `.js`/`.mjs` in the candidate | clean (4 files) |
| `node --test tests/model.test.mjs` | 13/13 pass; includes an independently written brute-force Kayles search over row bitmasks compared against the model's 64-entry table, and all 2^18 boards for the RTP |
| `node tools/enumerate.mjs` | `ENUMERATION OK`; 0 word->board mismatches, 0 Grundy mismatches over 262,144 boards |
| `solc --bin --bin-runtime --optimize --optimize-runs 200` | compiles; 2,452 B creation / 2,424 B runtime |
| `PORT=8921 node tools/serve.mjs` + headless Chrome | 200s on `index.html`, `model.mjs`, `sdk/guest.mjs`; a full round dealt, priced and revealed with no host; two rounds driven (one win, one loss) |
| `node tools/make-og-image.mjs --slug handicap --title HANDICAP --out .../og-image.png` | wrote a 1200x630 PNG; header re-read and asserted by the tool, then re-parsed with Python `struct` (signature ok, 1200x630, bit depth 8, colour type 2) |

## Shared og-image tool (brief §7)

`jam-candidates/tools/make-og-image.mjs` — dependency-free: `zlib` plus hand-rolled `IHDR`/`IDAT`/`IEND`
chunks and a CRC32 table, and a 5x7 bitmap font defined in the file (uppercase A–Z, 0–9, and the
punctuation the titles need). No canvas, no npm installs, no third-party font data. It renders a
two-colour socket grid on a beveled late-90s desktop card, with the title in the title bar and the
slug in a footer strip; the grid pattern is derived from an FNV-1a hash of the slug, so each
candidate gets a distinct, reproducible image. The tool re-reads the file it just wrote and fails
non-zero if the signature or the IHDR size/CRC is wrong.

Generated and wired (`og:image` as a **relative** path) for every candidate that had an `index.html`
at the time of running:

| candidate | image | og:image wired |
|---|---|---|
| `handicap` | 15,241 B | yes (written with the page) |
| `flood-exe` | 15,422 B | yes — inserted one `<meta property="og:image" content="og-image.png" />` line after its existing `og:description`; file grew by exactly 52 bytes and still ends with `</html>` |
| `jump-ladder` | 15,797 B | yes — same insertion after its `<title>`; +52 bytes |
| `ordered-runs` | 15,537 B | yes — after its `og:description`; +52 bytes |
| `lifeboat` | 15,355 B | yes — after its `<title>`; +52 bytes |

The insertion script refuses to touch a file that already has an `og:image` or that does not end with
`</html>` (the signature of a concurrent write), and it changes nothing else. **No candidate still
needs its `og:image` meta tag wired.**

## Unproven — stated plainly (rows corrected in Wave 3; see `docs/verification.txt` §3.8)

| claim | status |
|---|---|
| embed path in the local host harness | **PROVEN** — mounted + wageredThroughHost + settled, sessions 20 -> 21 (`docs/host-embed.json`) |
| embed path against the production Chain.wtf host | **EXTERNAL BLOCKED** — no entrant-accessible production host exists (`docs/testnet.md`) |
| contract runtime behaviour | **PROVEN on the local simulator** — deployed (block 21, `gasUsed` 471895), 21 sessions settled, 0 stuck / 0 parity failures (`docs/chain-proof.json`); production-chain runtime UNPROVEN |
| sound | **NOT TESTED** — headless Chrome has no audio device |
| narrow-viewport layout | **NOT TESTED** — only a desktop-sized window was driven |
| sandboxed-iframe behaviour | **OBSERVED in the local host harness** — the guest mounted, wagered and settled inside the host iframe; the production host's exact sandbox was not run |
| a public HTTPS deployment | **PROVEN** — https://chain-jam-handicap.vercel.app (READY); a standalone cold load resolved a round to `PAID 1.2325x` |
| the novelty claim ("backing the winner of a position you are dealt, under perfect play") | an argument about the field, not a measurement — `research/wave5-agent2-novelty.md` §4 scores it Medium-High at 55% confidence |
