# HANDICAP — standalone round

## Serve the built page

ES-module imports need an `http(s)` origin (module fetches from `file://` are blocked by the
same-origin policy in every browser), so the page must be **served**, never opened from disk.
The restructure splits the page into `index.html` + `src/app.js` + `src/styles.css`, and the build
copies `public/*` to the dist root, so the served tree is `dist/`:

```sh
npm run build                      # assemble dist/
npm run serve                      # serve dist/ on http://127.0.0.1:8921/
# then open http://127.0.0.1:8921/
```

Probe first (real output):

```
$ for u in / /src/app.js /src/styles.css /game/model.mjs /src/sdk/guest.mjs /game.manifest.json /og-image.png; do
    curl -s -o /dev/null -w "%{http_code} %{content_type} $u\n" "http://127.0.0.1:8921$u"; done
200 text/html; charset=utf-8 /
200 text/javascript; charset=utf-8 /src/app.js
200 text/css; charset=utf-8 /src/styles.css
200 text/javascript; charset=utf-8 /game/model.mjs
200 text/javascript; charset=utf-8 /src/sdk/guest.mjs
200 application/json; charset=utf-8 /game.manifest.json
200 image/png /og-image.png
```

`.mjs` is served as `text/javascript` so the browser evaluates the model as a module.

## The real headless-browser run (this restructure)

Driven over the DevTools Protocol with a headless Chrome 154 (the binary this machine's
browser toolchain resolves; any Chromium ≥ 130 works) by `tools/browser-check.mjs`
(`chrome --dump-dom` hangs on these pages because the 2.5 s grace timer never reaches idle). The
driver clicks **SECOND**, clicks **DEAL**, reads the settled round, then clicks **DEAL** again and
asserts a new board.

```
$ npm run build && npm run serve &        # http://127.0.0.1:8921/
$ node tools/browser-check.mjs http://127.0.0.1:8921/

page      : HANDICAP — back the winner of a position you are dealt
render    : 18 sockets (12 pins), 6 payline bands
host      : HOST: standalone demo  wallet WALLET: n/a  ::  MODEL: handicap v1 ok
pick      : clicked SECOND -> FIRST.on=false SECOND.on=true

round 1 result : NO RETURN — FIRST WINS You backed SECOND. Grundy = 2 (XOR of 0, 1, 3), so first wins
                 under perfect play. Branching 9 -> VOL 4.
round 1 engine : ROW A ▮▯▯▯▯▮ G(33) 0 ROW B ▮▯▯▮▯▮ G(41) 1 ROW C ▮▯▮▮▯▯ G(13) 3 GRUNDY XOR of the
                 three rows 2 PERFECT PLAY FIRST WINS BRANCHING legal moves 9 VOLATILITY TIER
                 VOL 4 / 5 PRICE FIRST 1.2639x PRICE SECOND 3.8252x PAYOUT backing SECOND 0.0000x
round 1 board  : word 0x9cda61bc…f2b8b6 | board 55905
round 1 source : source: standalone CSPRNG deal

assert    : settled=true grundy=true branching=true payout=true dirty=false
screenshot: docs/browser-round.png (89999 B)

round 2 result : PAID 3.8252x — SECOND WINS You backed SECOND. Grundy = 0 (XOR of 3, 1, 2), so second
                 wins under perfect play. Branching 9 -> VOL 4.
round 2 board  : word 0xb4c407d3…1cbc13 | board 50183

BROWSER CHECK PASS  (http://127.0.0.1:8921/)
  page loads; UI renders; pick works; DEAL runs; round resolves with winner/Grundy/
  branching/payout; dealing again produced a new round.
```

This run exercises **both** settlement paths with the pick on SECOND. Round 1's rows are
`G(33)=0`, `G(41)=1`, `G(13)=3`, so `0 XOR 1 XOR 3 = 2 != 0` and FIRST wins; the player backed
SECOND, so the payout is `0.0000x`. The branching factor is the sum of the row legal-move counts,
`2 + 3 + 4 = 9`, which lands in the tier-3 bucket `7..10` = `VOL 4`. Round 2 draws
`Grundy = 0`, so SECOND wins and the SECOND side pays its tier-3 price `38252/10000 = 3.8252x` —
the page shows `PAID 3.8252x`. The board changed across the two deals (`55905` → `50183`), proving
the second DEAL drew a new word rather than repainting. The screenshot of the settled round is
`docs/browser-round.png`.

## Candidate-phase observation (preserved)

The candidate (pre-restructure, a single inlined `index.html`) was also driven from a local server
in headless Chrome; the first round it dealt reached `PAID 1.2260x — FIRST WINS` with the pick on
FIRST, exercising the **win** path. That record is kept because the restructure did not change the
reveal logic; `docs/preview.png` is the candidate's settled-round screenshot and
`docs/dist-preview.png` a preview of its dist build.

## The public HTTPS deployment (Wave 3)

The project was deployed to a public HTTPS URL — the entrant's own hosting obligation. Evidence:
`research/public-deploy-top3.md`.

| field | value |
|---|---|
| production URL | https://chain-jam-handicap.vercel.app |
| deployment id | `dpl_DWwxBWquMpkygHfZYkGC7wpv2rXV` |
| state | READY |

External probe (from the coordinator's machine, not localhost): `GET /` `200 text/html`,
`GET /game/model.mjs` `200 application/javascript`, `GET /src/app.js` `200 application/javascript`,
`GET /game.manifest.json` `200 application/json` with `access-control-allow-origin: *` and
`cache-control: public, max-age=300`; no `X-Frame-Options` and no CSP `frame-ancestors`; the
`jam.chain.wtf/widget.js` tag is present in the body.

Standalone real-browser run at the production URL (headless Chrome, no host attached): the page
loads, **FIRST** was picked, **DEAL** resolved to `PAID 1.2325x — FIRST WINS`, and the widget badge
("CHAIN JAM VOL.1") rendered. The page fell through to its standalone demo with **no hang** — the
`connection.promise` guard documented above works on the real network. (No separate cold-load TTI
figure was measured; the observation is that a cold load resolves to a settled round.)

## What was and was not tested

| claim | status |
|---|---|
| built `dist/` served; every asset 200 with the expected content type | **PROVEN** (probe above) |
| page loads and the UI renders in a real headless browser | **PROVEN** (18 sockets, 6 bands) |
| the FIRST/SECOND pick control works | **PROVEN** (clicking SECOND flips the highlight) |
| DEAL runs a round and it RESOLVES | **PROVEN** (round 1 settled: winner + Grundy + branching + payout) |
| the result text is present and readable | **PROVEN** (verbatim above) |
| dealing again produces a NEW round | **PROVEN** (board 55905 → 50183) |
| sound | **NOT TESTED** — headless Chrome has no audio device; the code is gesture-gated and wrapped in `try/catch` |
| layout on a narrow viewport | **NOT TESTED** — only a desktop-sized window was driven |
| public HTTPS URL, cold load, standalone round | **PROVEN** — https://chain-jam-handicap.vercel.app resolved a round to `PAID 1.2325x` in a real browser (section above) |
| embed path in the local host harness | **PROVEN** — mounted + wageredThroughHost + settled, sessions 20 -> 21 (`docs/host-embed.json`) |
| embed path against the production Chain.wtf host | **EXTERNAL BLOCKED** — no entrant-accessible production host exists; see `docs/testnet.md` |
