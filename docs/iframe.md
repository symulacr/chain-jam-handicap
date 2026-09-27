# HANDICAP — iframe safety

Checklist against `research/wave5-agent3-beyond-wine.md` §6.1, which is the authoritative table of
what breaks inside the host's `allow-scripts allow-same-origin` frame.

| capability | rule | HANDICAP | evidence |
|---|---|---|---|
| service worker | never register | **not used** | no `serviceWorker` anywhere in `index.html` |
| `localStorage` / `sessionStorage` / `IndexedDB` / Cache API | persist nothing | **not used** | all state is module-local (`pick`, `snapshot`, `pending`, `host`); nothing is written |
| `document.cookie` | never read or write | **not used** | — |
| `window.open`, `target="_blank"` | blocked | **not used** | — |
| `alert` / `confirm` / `prompt` | blocked | **not used** | results and errors render into the in-page `#result` / `#note` panels |
| `top.location` | host owns the top frame | **not used** | — |
| downloads, pointer lock, fullscreen, Web Share | blocked | **not used** | — |
| clipboard | may be blocked; keep out of the money path | **not used** | no copy affordance |
| `vh` / `vw` units | semantically wrong inside a grown iframe | **not used** | layout uses px, `%`, `max-width`, and flex wrapping |
| WebAudio | allowed, `suspended` until a gesture | **resumed on gesture** | `chime()` calls `audio.resume()` when `state === 'suspended'`; the first call is the user's DEAL/BET, and the on-load paint passes `silent = true` so no context is created before a gesture |
| snapshot-driven rendering | reflect `setState`, never touch the wallet | **yes** | the page only reads `wallet.status`, `token.*`, `casino.*`, `sessions.items`; the only host call in the money path is `openSession` |
| bridge lifecycle | connect on mount, await `connection.promise`, enable betting after it resolves, destroy on unload | **yes** | betting is disabled until the promise resolves; `beforeunload` calls `connection.destroy()` |
| report content height | `observeGameContentSize(hostApi)` | **yes** | called once, when the bridge resolves |
| respect `ui.theme` / `prefers-reduced-motion` | — | **partially** | the palette is fixed (a deliberate period look); there are no transitions or animations to suppress, so `prefers-reduced-motion` has nothing to act on |
| feature-detect optionals | treat an absent `casino` block as unknown | **yes** | `computeMaxWager` returns `{kind:'unknown'}` and no limit is assumed; the wager field simply has no host-derived ceiling |
| frame-blocking response headers and CSP ancestor directives | never ship a blocker | **none** | the shipped `public/_headers` and `public/vercel.json` set CORS on `/game.manifest.json` only; neither sets `X-Frame-Options` nor a CSP `frame-ancestors`, so no framing blocker is shipped (harness check 6 confirms this) |
| `?ref=chainjam` | tolerate unknown query params | **yes** | the page never reads `location.search`, so every query string is inherently tolerated |
| CORS | not required | **none added** | — |

## Resource list the page actually fetches

| resource | origin | notes |
|---|---|---|
| `./src/app.js` | same origin | the page module |
| `./src/styles.css` | same origin | the page stylesheet |
| `./game/model.mjs` | same origin | the model the harness verified |
| `./src/sdk/guest.mjs` | same origin | byte-identical copy of `shared/guest.mjs` |
| `./og-image.png` | same origin | only referenced as `og:image` metadata; never drawn |
| `https://jam.chain.wtf/widget.js` | the jam | the literal the automatic submit check enforces; loaded `async`, and the page works with it blocked |

No fonts, no images drawn on the page, no CSS `@import`, no analytics. The board, the bevels and the
title bar are CSS; the pins are CSS radial gradients.

## What is observed, and what is still argued

**Observed (Wave 3).** The game was mounted in the SDK's production-faithful host iframe, a wager was
placed through the bridge (`openSession`), and the session settled with the guest rendering the
result — `mounted=true`, `wageredOnChain=true`, `sawSettle=true`, sessions 20 -> 21
(`docs/host-embed.json`). That exercises the embed path end to end. A top-level standalone page load
was also run, from a local static server and from the public HTTPS URL (see `standalone.md`).

**Still argued, not observed.** The rules above are additionally satisfied **by construction and by
reading the source**, and the production Chain.wtf host's exact sandbox was NOT run: the host above
is the local simulator harness, not the production host. So the stronger claim — "nothing here
throws under the production host's sandbox" — remains an argument, not an observation.
Production-host embedding is EXTERNAL BLOCKED (`docs/testnet.md`).
