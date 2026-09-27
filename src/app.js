// HANDICAP — frontend app. Extracted verbatim from the verified candidate's inline module script.
// The only edits are the import specifiers: `./model.mjs` -> `../game/model.mjs` and
// `./sdk/guest.mjs` -> `./sdk/guest.mjs`. The reveal path, the pricing display and the host bridge
// wiring are unchanged, because they were already verified.
import { SLUG, BANDS, EXPECTED_RTP_BPS, outcome, makeRng } from '../game/model.mjs';
import { SessionPhase, computeMaxWager, connectGameToHost, observeGameContentSize } from './sdk/guest.mjs';

const $ = (id) => document.getElementById(id);

const ROWS = 3;
const COLS = 6;
const HEXCHARS = '0123456789abcdef';

let pick = 'first';       // committed BEFORE the deal; ignored by outcome(), used to choose a price
let host = null;
let hostReady = false;
let snapshot = null;
let busy = false;
let pending = null;       // { sessionKey, sessionId, wager, pick }
let maxWagerBase = null;  // bigint host limit in base units, when the host publishes one
let watchdog = 0;

// ------------------------------------------------------------------ rendering
function renderBoard(board, touched) {
  const el = $('board');
  el.innerHTML = '';
  for (let r = 0; r < ROWS; r += 1) {
    const row = document.createElement('div');
    row.className = 'row';
    const tag = document.createElement('span');
    tag.className = 'rowtag';
    tag.textContent = 'ROW ' + String.fromCharCode(65 + r);
    row.appendChild(tag);
    const pat = (board >> (6 * r)) & 63;
    for (let c = 0; c < COLS; c += 1) {
      const s = document.createElement('div');
      const bit = (pat >> c) & 1;
      s.className = 'socket' + (bit ? ' pin' : '');
      if (bit && touched) s.classList.add('touched');
      s.title = bit ? 'pin' : 'empty socket';
      row.appendChild(s);
    }
    el.appendChild(row);
  }
}

function line(k, v, cls) {
  const d = document.createElement('div');
  d.className = 'l';
  const a = document.createElement('span');
  a.className = 'k';
  a.textContent = k;
  const b = document.createElement('span');
  b.className = 'v' + (cls ? ' ' + cls : '');
  b.textContent = v;
  d.appendChild(a);
  d.appendChild(b);
  return d;
}

function renderEngine(detail, mk) {
  const el = $('engine');
  el.innerHTML = '';
  for (let r = 0; r < ROWS; r += 1) {
    const pat = detail.rows[r];
    let bits = '';
    for (let c = 0; c < COLS; c += 1) bits += (pat >> c) & 1 ? '\u25AE' : '\u25AF';
    el.appendChild(line('ROW ' + String.fromCharCode(65 + r) + '  ' + bits + '   G(' + pat + ')', String(detail.rowGrundy[r])));
  }
  el.appendChild(line('GRUNDY  XOR of the three rows', String(detail.grundy), detail.grundy !== 0 ? 'ok' : 'hi'));
  el.appendChild(line('PERFECT PLAY', detail.winner + ' WINS', detail.winner === 'FIRST' ? 'ok' : 'hi'));
  el.appendChild(line('BRANCHING  legal moves', String(detail.moves)));
  el.appendChild(line('VOLATILITY TIER', 'VOL ' + (detail.tier + 1) + ' / 5'));
  el.appendChild(line('PRICE  FIRST', (detail.priceFirstBps / 10000).toFixed(4) + 'x'));
  el.appendChild(line('PRICE  SECOND', (detail.priceSecondBps / 10000).toFixed(4) + 'x'));
  el.appendChild(line('PAYOUT  backing ' + pick.toUpperCase(), mk == null ? '\u2014' : mk.toFixed(4) + 'x'));
}

function renderResult(detail, mk, pickLed, extra) {
  const el = $('result');
  el.className = 'result ' + (mk > 0 ? 'win' : 'lose');
  el.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'head';
  h.textContent = mk > 0
    ? 'PAID ' + mk.toFixed(4) + 'x  —  ' + detail.winner + ' WINS'
    : 'NO RETURN  —  ' + detail.winner + ' WINS';
  const s = document.createElement('div');
  s.className = 'sub';
  s.textContent = 'You backed ' + pickLed + '. Grundy = ' + detail.grundy + ' (XOR of '
    + detail.rowGrundy.join(', ') + '), so ' + detail.winner.toLowerCase()
    + ' wins under perfect play. Branching ' + detail.moves + ' -> VOL ' + (detail.tier + 1) + '.'
    + (extra ? ' ' + extra : '');
  el.appendChild(h);
  el.appendChild(s);
}

function renderBands() {
  const t = $('bands');
  t.innerHTML = '';
  const head = document.createElement('tr');
  for (const h of ['stat', 'First-side payout', 'what it means']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  t.appendChild(head);
  const meaning = [
    'SECOND wins — no return',
    'FIRST wins — VOL 1, tightest position',
    'FIRST wins — VOL 2',
    'FIRST wins — VOL 3',
    'FIRST wins — VOL 4',
    'FIRST wins — VOL 5, most open position',
  ];
  BANDS.forEach((b, i) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = b.min === b.max ? String(b.min) : b.min + '..' + b.max;
    const c = document.createElement('td');
    c.textContent = b.mult === 0 ? '0x' : b.mult.toFixed(4) + 'x';
    const d = document.createElement('td');
    d.textContent = meaning[i] ?? '';
    tr.appendChild(a); tr.appendChild(c); tr.appendChild(d);
    t.appendChild(tr);
  });
  $('rtp').textContent = (EXPECTED_RTP_BPS / 100).toFixed(2) + '% (exact, by enumeration)';
}

// ------------------------------------------------------------------ the one reveal path
function wordFromBoard(board) {
  let hex = '0x';
  for (const shift of [16, 8, 0]) hex += HEXCHARS[(board >> shift) & 15] + '0';
  return hex + '0'.repeat(58);
}

function reveal(word, pickUsed, sourceName, contractGame, silent) {
  const o = outcome(word);
  const detail = {
    rows: o.rows,
    rowGrundy: o.rowGrundy,
    grundy: o.grundy,
    moves: o.moves,
    tier: o.tier,
    winner: o.winner,
    priceFirstBps: o.priceFirstBps,
    priceSecondBps: o.priceSecondBps,
  };
  if (contractGame) {
    // contract is authoritative for money and for the position it scored
    detail.rows = [(contractGame.board >> 0) & 63, (contractGame.board >> 6) & 63, (contractGame.board >> 12) & 63];
    detail.grundy = contractGame.grundy;
    detail.moves = contractGame.moves;
    detail.tier = contractGame.tier;
    detail.winner = contractGame.grundy !== 0 ? 'FIRST' : 'SECOND';
    const chk = outcome(wordFromBoard(contractGame.board));
    detail.priceFirstBps = chk.priceFirstBps;
    detail.priceSecondBps = chk.priceSecondBps;
    const agree = chk.grundy === contractGame.grundy && chk.tier === contractGame.tier;
    $('paritycell').textContent = 'MODEL: ' + (agree ? 'matches contract' : 'MISMATCH');
    if (!agree) $('paritycell').style.color = '#b00020';
  } else {
    $('paritycell').textContent = 'MODEL: ' + SLUG + ' v1 ok';
  }
  const isFirst = pickUsed === 'first';
  const won = isFirst ? detail.winner === 'FIRST' : detail.winner === 'SECOND';
  const priceBps = isFirst ? detail.priceFirstBps : detail.priceSecondBps;
  let mk = null;
  let extra = '';
  if (contractGame) {
    mk = contractGame.wager > 0n ? Number(contractGame.payout * 10000n / contractGame.wager) / 10000 : 0;
    extra = 'Settled on-chain.';
  } else {
    mk = won ? priceBps / 10000 : 0;
  }
  renderBoard(detail.rows.reduce((a, p, r) => a | (p << (6 * r)), 0), won);
  renderEngine(detail, mk);
  renderResult(detail, mk, isFirst ? 'FIRST' : 'SECOND', extra);
  $('boardmeta').textContent = 'word ' + word.slice(0, 10) + '…' + word.slice(-6)
    + '  |  board ' + (detail.rows.reduce((a, p, r) => a | (p << (6 * r)), 0));
  $('source').textContent = sourceName;
  if (!silent) chime(mk > 0);
  return { detail, mk, won, stat: o.stat };
}

// ------------------------------------------------------------------ sound (optional, gesture-gated)
let audio = null;
function chime(win) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = win ? 660 : 180;
    if (win) osc.frequency.setValueAtTime(880, t + 0.08);
    gain.gain.setValueAtTime(0.03, t);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(t); osc.stop(t + 0.2);
  } catch (_) { /* sound is optional */ }
}

// ------------------------------------------------------------------ pick + demo deal
function setPick(next) {
  pick = next;
  $('pickFirst').classList.toggle('on', pick === 'first');
  $('pickSecond').classList.toggle('on', pick === 'second');
}
$('pickFirst').addEventListener('click', () => setPick('first'));
$('pickSecond').addEventListener('click', () => setPick('second'));

$('deal').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let word = '0x';
  for (const b of bytes) word += HEXCHARS[b >> 4] + HEXCHARS[b & 15];
  reveal(word, pick, 'source: standalone CSPRNG deal', null);
});

// ------------------------------------------------------------------ tab strip (section nav)
// Wave 4: BOARD / ENGINE / RULES were inert `div`s that swallowed clicks and did nothing.
// They are now native in-page anchors to the matching panel (the browser scrolls to the
// target and `:target` outlines it); this handler only keeps the active highlight in sync.
const tabStrip = [...document.querySelectorAll('.tabstrip .tab')];
tabStrip.forEach((tab) => {
  tab.addEventListener('click', () => tabStrip.forEach((t) => t.classList.toggle('on', t === tab)));
});

// ------------------------------------------------------------------ embedded (host) path
function decodeGameState(hex) {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length < 64 * 6) return null;
  const at = (i) => BigInt('0x' + body.slice(i * 64, (i + 1) * 64));
  return { board: Number(at(0)), grundy: Number(at(1)), moves: Number(at(2)), tier: Number(at(3)), pick: Number(at(4)), payout: at(5) };
}

function applySnapshot(next) {
  snapshot = next;
  const wallet = next?.wallet?.status;
  const ready = wallet === 'ready';
  $('walletcell').textContent = 'WALLET: ' + (wallet ?? 'unknown');
  if (!hostReady) return;
  const decimals = Number(next?.token?.decimals ?? 18);
  const sym = next?.token?.symbol ?? 'CHIPS';
  $('wagerLabel').textContent = 'WAGER (' + sym + ')';
  const lim = computeMaxWager(next, { maxMultiplierX: 8.05 });
  maxWagerBase = lim.kind === 'limit' && typeof lim.maxWager === 'bigint' ? lim.maxWager : null;
  if (maxWagerBase !== null) {
    const whole = maxWagerBase / (10n ** BigInt(decimals));
    const frac = maxWagerBase % (10n ** BigInt(decimals));
    $('wager').title = 'host limit: about ' + whole.toString() + (frac > 0n ? '.' + frac.toString().padStart(decimals, '0').slice(0, 4) : '') + ' ' + sym;
  }
  $('wager').disabled = !ready || busy;
  $('bet').disabled = !ready || busy;
  $('wager').setAttribute('aria-disabled', String(!ready || busy));
  $('bet').setAttribute('aria-disabled', String(!ready || busy));
  if (pending) {
    const items = next?.sessions?.items ?? [];
    const row = items.find((x) => x.sessionKey === pending.sessionKey);
    if (row && (row.isSettled || row.phase === SessionPhase.SETTLED) && row.raw?.gameState) {
      const g = decodeGameState(row.raw.gameState);
      const p = pending;
      pending = null;
      busy = false;
      clearTimeout(watchdog);
      if (g) {
        g.wager = BigInt(row.stake ?? row.wager ?? p.wager ?? '0');
        revealCall(row, p, g);
      }
    }
  }
}

function revealCall(row, p, g) {
  const word = wordFromBoard(g.board);
  reveal(word, p.pick === 2 ? 'second' : 'first', 'source: settled on-chain session ' + row.sessionId, g);
  try { void host?.revealOutcome({ sessionId: row.sessionId }).catch(() => {}); } catch (_) { /* optional */ }
}

$('bet').addEventListener('click', () => {
  if (!hostReady || !host || busy) return;
  const raw = String($('wager').value || '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
    $('note').textContent = 'Wager must be a decimal number of tokens.';
    return;
  }
  if (maxWagerBase !== null) {
    const decimals = Number(snapshot?.token?.decimals ?? 18);
    const parts = raw.split('.');
    const frac = ((parts[1] ?? '') + '0'.repeat(decimals)).slice(0, decimals);
    const base = BigInt(parts[0] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
    if (base > maxWagerBase) {
      $('note').textContent = 'Wager exceeds the host risk limit for this game right now; lower it.';
      return;
    }
  }
  busy = true;
  pending = { sessionKey: null, sessionId: null, wager: raw, pick: pick === 'second' ? 2 : 1 };
  const gameData = pick === 'second' ? '0x02' : '0x01';
  host.openSession({ wager: raw, gameData })
    .then((res) => {
      pending.sessionKey = res.sessionKey;
      $('note').textContent = 'Session ' + res.sessionKey + ' opened; waiting for the word.';
      watchdog = setTimeout(() => {
        if (pending) {
          pending = null;
          busy = false;
          $('note').textContent = 'No settlement observed within 90s — the session is still on-chain; '
            + 'reload the history panel to watch it.';
        }
      }, 90000);
    })
    .catch((err) => {
      pending = null;
      busy = false;
      $('note').textContent = 'openSession was refused: ' + String(err && err.message ? err.message : err);
    });
});

function enterStandalone(why) {
  hostReady = false;
  host = null;
  $('hostcell').textContent = 'HOST: standalone demo';
  $('walletcell').textContent = 'WALLET: n/a';
  $('wager').disabled = true;
  $('bet').disabled = true;
  $('deal').disabled = false;
  // D3: the standalone wager is inert by design (no host => no money). Say so on the slip
  // (a full line, so the bet-bar layout does not reflow) instead of leaving it looking broken.
  $('cap').textContent = 'Back a side before the deal \u2014 demo, no wager';
  $('wager').setAttribute('aria-disabled', 'true');
  $('wager').title = 'Standalone demo \u2014 no wager is placed. BET needs the Chain.wtf host; use DEAL for a free demo round.';
  $('bet').setAttribute('aria-disabled', 'true');
  $('bet').title = 'BET needs the Chain.wtf host. Standalone runs a free demo \u2014 use DEAL.';
  $('note').textContent = why;
}

$('deal').disabled = false;

// enable the embed path only if the bridge actually answers; never block the demo
let connection = null;
try {
  connection = connectGameToHost({
    async setState(next) { applySnapshot(next); },
  });
  void connection.promise
    .then((api) => {
      if (!api) { enterStandalone('Bridge returned no host API: running the standalone demo.'); return; }
      host = api;
      hostReady = true;
      $('hostcell').textContent = 'HOST: connected';
      if (typeof observeGameContentSize === 'function') observeGameContentSize(api);
      $('note').textContent = 'Connected to the host. Pick a side, enter a wager, then BET.';
      $('bet').disabled = false;
      // A real host is present: drop the standalone-only "demo, no wager" affordance.
      $('cap').textContent = 'Back a side before the deal';
      $('wager').removeAttribute('aria-disabled');
      $('bet').removeAttribute('aria-disabled');
      $('wager').title = '';
      $('bet').title = '';
    })
    .catch(() => { enterStandalone('No host answered: running the standalone demo.'); });
} catch (_) {
  enterStandalone('Bridge unavailable in this context: running the standalone demo.');
}
// never hang: if nothing answered in 2.5 s, the demo is the game
setTimeout(() => { if (!hostReady) enterStandalone('No host answered: running the standalone demo.'); }, 2500);

window.addEventListener('beforeunload', () => { try { connection?.destroy(); } catch (_) { /* nothing */ } });

renderBands();
renderBoard(0, false);
// a dealt board on first paint so the page is never empty
reveal(makeRng('0x' + '00'.repeat(31) + '01', 1), 'first', 'source: sample word makeRng(seed,1)', null, true);
