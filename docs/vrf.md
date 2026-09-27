# HANDICAP — VRF usage

## One word, one position, one exact value

`outcome(word)` reads **bits 232..255** of the 32-byte VRF word — the first three bytes, taken as a
24-bit big-endian integer — and keeps the low 18 bits as the board. Nothing else from the word is
used, and nothing outside the word is used at all.

```
bit 6*row + col  == 1   =>  socket (row, col) carries a pin
row 0 = bits 0..5, row 1 = bits 6..11, row 2 = bits 12..17
```

Since those 18 bits of a uniform word are uniform and independent, the dealt board is exactly
uniform over the 2^18 possible boards. That is the only distributional assumption in the whole
candidate, and it is what makes the RTP exactly enumerable (see `rtp.md`).

`outcome()` is pure: no `crypto`, no I/O, no clock, no ambient state, no second input. The harness's
own words (2,000,000 `crypto.randomBytes` draws) drive it unchanged.

## Bit order agreed in three places

The Solidity decode is `uint256(randomness) >> 232` masked to 18 bits, i.e.
`(uint256(randomness) >> 232) & 0x3ffff`. That is the same value JS gets from the first 6 hex
characters. Rather than assert the agreement, `tools/enumerate.mjs` re-encodes the Solidity
expression independently (from three bytes, not from the hex string), builds a word for **every**
board, and checks:

- `outcome(word).board === board` for all 262,144 boards → 0 mismatches,
- `outcome(word).grundy === expected XOR` for all 262,144 boards → 0 mismatches,
- `outcome(word).stat === (g != 0 ? 8 : 0) + tier` for all 262,144 boards → 0 mismatches.

## The deal is not a dice roll on a byte

No `byte % N` rejection loop, no modulo bias, no "first byte that is small enough": the entire
position is a fixed-width slice of the word, so every board is exactly equally likely by
construction. There is nothing to debias.

## Why 238 unused bits are fine

The page shows `word` and `board` so a reviewer can see exactly which bits were used. Using more
bits would not add information: the board fully determines the Grundy value, the branching factor,
the tier and therefore the payout. The remaining 238 bits of the word are unread by design, and the
contract's `_board()` reads the same slice.

## Round sampler

`makeRng(seed0, round)` is used by the benchmark harness and the page's sample word, not by the deal
itself (the deal consumes a real VRF word in production). It is counter-based, exact for every integer
round, and injective within each 2^32-round window; collision-freedom across all `(lo, hi)` is NOT
proven (the tests sweep seven magnitude windows up to 2^52 with 0 collisions — a cross-check, not a
proof). The derivation is in `rtp.md` §5; see also `docs/adversarial.md`.

## Settlement sequence

```
openSession(gameData = 0x01 | 0x02)      player commits FIRST or SECOND
  -> onSessionStart                       reserve committed at the worst-case price
  -> requestRandomnessNow = true
  -> onRandomness(randomness)             board, exact Grundy, tier, price, payout
  -> SETTLED, reservedProfitDelta = 0
```

There is no player action and no second step. The contract's `submitAction` capability is `false`,
`onPlayerAction` reverts, and `quoteForfeitPayout` returns 0. A round cannot get stuck waiting on
the player, and there is nothing to cancel mid-flight beyond the standard stuck-randomness path the
manifest advertises (`cancelStuckRandomness: true`).
