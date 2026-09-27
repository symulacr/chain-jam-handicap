// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICasinoGameV2, SessionContext, SessionPhase, StepResult} from "./ICasinoGameV2.sol";

/**
 * HANDICAP — back the winner of an impartial position you are dealt, under perfect play.
 *
 *   One VRF word deals an 18-socket board (3 rows x 6 columns). A filled socket is a pin and
 *   the position is KAYLES, the pin game (octal game .77): a move knocks down one pin, or two
 *   adjacent pins in a row, and the player who cannot move loses. A row's Grundy value depends
 *   only on its own 6-bit pattern, so the position is the disjoint sum of the three row games
 *   and its Sprague-Grundy value is the XOR of the row values:
 *
 *       g != 0  ->  FIRST wins under perfect play
 *       g == 0  ->  SECOND wins under perfect play
 *
 *   Nothing is simulated and no search is bounded: _grundyAndMoves() returns the EXACT Grundy
 *   value, so the settlement is decided the moment the word is known, before a single move is
 *   made. The player commits to FIRST or SECOND in `gameData` at openSession time, i.e. before
 *   the word exists.
 *
 * PAYLINE (graded by the position's volatility)
 *   A flat price on a binary winner would be a coin flip. The board's branching factor — the
 *   number of legal moves, sum over maximal runs of length L of (2L-1) — is bucketed into five
 *   volatility tiers, and each tier quotes its own price on each side. The price is the FAIR
 *   price for that tier, price = 9500 / P(side wins | tier), so both sides of the book return
 *   the same expected value in every tier. Prices in bps:
 *
 *     tier  branching   P(FIRST)   price FIRST   price SECOND
 *      0      19..33      0.8820      1.0771x       8.0492x
 *      1      14..18      0.7749      1.2260x       4.2195x
 *      2      11..13      0.7708      1.2325x       4.1451x
 *      3       7..10      0.7516      1.2639x       3.8252x
 *      4        0..6      0.6753      1.4068x       2.9258x
 *
 *   The tier counts above are EXACT: the board space is 2^18 and tools/enumerate.mjs walks all
 *   of it (see rtp-proof.md). The seed space is 2^256, but outcome() reads only bits 232..255,
 *   so the position distribution is exactly uniform over those 2^18 boards.
 *
 * PARITY WITH model.mjs
 *   Every table below is generated from model.mjs and re-checked by tests/model.test.mjs:
 *   board decode, the two packed row tables (Grundy and legal-move counts, 4 bits per entry),
 *   the tier thresholds, and the two price tables. The paytable is the same integers, so it is
 *   band-for-band identical rather than merely re-derived.
 *
 * RESERVE DISCIPLINE
 *   onSessionStart commits the full worst-case reserve and the settling step returns
 *   reservedProfitDelta = 0. quoteCaps, quoteRiskParams, onSessionStart and onRandomness all
 *   route through the same _payout() so the reserve budget and the payout cannot disagree.
 */
contract HandicapGame is ICasinoGameV2 {
  uint256 private constant BPS = 10000;
  uint256 private constant CELLS = 18;

  /// @dev Kayles row Grundy values, 4 bits per 6-bit row pattern, pattern 0 in the low nibble.
  uint256 private constant ROW_G_PACKED =
    23522160150126406126458105914335319089144387978904602028995348962669255270672;
  /// @dev Legal-move count per 6-bit row pattern, 4 bits per pattern.
  uint256 private constant ROW_MOVES_PACKED =
    83917328912761010848275247999620322632853111151828361437429670211043433984272;

  /// @dev Fair price (bps) for backing FIRST, per tier. price = 9500 / P(FIRST wins | tier).
  uint256 private constant PRICE_FIRST_PACKED = 10771 | (12260 << 32) | (12325 << 64) | (12639 << 96) |
    (14068 << 128);
  /// @dev Fair price (bps) for backing SECOND, per tier. price = 9500 / P(SECOND wins | tier).
  uint256 private constant PRICE_SECOND_PACKED = 80492 | (42195 << 32) | (41451 << 64) | (38252 << 96) |
    (29258 << 128);

  uint256 private constant MAX_PRICE_BPS = 80492; // highest price on either side of any tier
  uint256 private constant EXPECTED_RTP_BPS = 9500; // exact, by enumeration (rtp-proof.md)
  /// @dev Per-side risk quotes, exact from the 2^18 enumeration (tools/enumerate.mjs).
  ///      `bodyVarianceScaled` must exclude EXACTLY the tier whose probability is returned as
  ///      `probabilityWad` — the highest-multiplier WINNING tier for that side — so the on-chain
  ///      top-tier binary term and the quoted body term never double-count
  ///      (SLOTS_RISK_AND_RESERVES.md invariant 4). Both fields are side-dependent, so
  ///      quoteRiskParams decodes gameData exactly as onSessionStart does.
  ///        FIRST  tops out at tier 4 (1.4068x):  P = 8808/2^18; body variance over tiers 0..3.
  ///        SECOND tops out at tier 0 (8.0492x):  P = 2633/2^18; body variance over tiers 1..4.
  uint256 private constant P_TOP_FIRST_WAD = 33599853515625000; //   8808 / 2^18
  uint256 private constant P_TOP_SECOND_WAD = 10044097900390625; //  2633 / 2^18
  uint256 private constant BODY_VAR_FIRST = 290760843382584294; //  ΣpM²−(ΣpM)² over tiers 0..3, *1e18
  uint256 private constant BODY_VAR_SECOND = 2734806412979170708; // ΣpM²−(ΣpM)² over tiers 1..4, *1e18

  error HandicapGame__NoPlayerAction();
  error HandicapGame__BadPick(uint8 pick);

  // ------------------------------------------------------------------ deal
  /// @dev Bits 232..255 of the word, low 18 bits = the board. Identical to model.mjs boardOf().
  function _board(bytes32 randomness) internal pure returns (uint256) {
    return (uint256(randomness) >> 232) & 0x3ffff;
  }

  /// @dev Exact Sprague-Grundy value of the dealt position and its branching factor.
  function _grundyAndMoves(uint256 board) internal pure returns (uint256 grundy, uint256 moves) {
    uint256 p0 = board & 63;
    uint256 p1 = (board >> 6) & 63;
    uint256 p2 = (board >> 12) & 63;
    grundy = ((ROW_G_PACKED >> (4 * p0)) & 0xf) ^ ((ROW_G_PACKED >> (4 * p1)) & 0xf) ^
      ((ROW_G_PACKED >> (4 * p2)) & 0xf);
    moves = ((ROW_MOVES_PACKED >> (4 * p0)) & 0xf) + ((ROW_MOVES_PACKED >> (4 * p1)) & 0xf) +
      ((ROW_MOVES_PACKED >> (4 * p2)) & 0xf);
  }

  /// @dev Volatility tier from the branching factor. Boundaries mirror model.mjs tierOfMoves().
  function _tier(uint256 moves) internal pure returns (uint256) {
    if (moves >= 19) return 0;
    if (moves >= 14) return 1;
    if (moves >= 11) return 2;
    if (moves >= 7) return 3;
    return 4;
  }

  function _priceFirst(uint256 tier) internal pure returns (uint256) {
    return (PRICE_FIRST_PACKED >> (32 * tier)) & 0xffffffff;
  }

  function _priceSecond(uint256 tier) internal pure returns (uint256) {
    return (PRICE_SECOND_PACKED >> (32 * tier)) & 0xffffffff;
  }

  /// @dev 1 = FIRST, 2 = SECOND. The pre-commit hint carried in gameData.
  function _pick(bytes calldata gameData) internal pure returns (uint8) {
    if (gameData.length == 0) return 1; // no hint supplied: FIRST
    uint8 p = uint8(gameData[0]);
    if (p != 1 && p != 2) revert HandicapGame__BadPick(p);
    return p;
  }

  /// @dev The side the player COMMITTED, read back from the gameState written at
  ///      onSessionStart (abi.encode(uint256 pick)) rather than re-read from gameData.
  ///      The committed value is authoritative once it exists, so the settlement grades the
  ///      side that was actually locked in. gameData remains the fallback for a context that
  ///      has not passed through onSessionStart (or supplies no state), so behaviour cannot
  ///      regress: with the host lifecycle both paths always agree.
  function _committedPick(SessionContext calldata ctx) internal pure returns (uint8) {
    bytes calldata gs = ctx.gameState;
    if (gs.length == 32) {
      uint256 v = abi.decode(gs, (uint256));
      if (v == 1 || v == 2) return uint8(v);
    }
    return _pick(ctx.gameData);
  }

  // ------------------------------------------------------------------ payline
  /// @dev Single source of truth for the tokens returned to the player on settle.
  function _payout(uint256 wager, uint256 priceBps) internal pure returns (uint256) {
    return (wager * priceBps) / BPS;
  }

  // ------------------------------------------------------------------ interface
  function quoteCaps(
    uint256 wager,
    bytes calldata
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    maxEscrowStake = wager;
    maxReservedProfit = (wager * MAX_PRICE_BPS) / BPS - wager;
  }

  /// @dev Quoted for the side named in gameData, decoded exactly as onSessionStart decodes it, so
  ///      the quote always matches the round that will actually run
  ///      (SLOTS_RISK_AND_RESERVES.md invariant 3). The previous version ignored gameData and quoted
  ///      one (wrong, ~23-28x low) body variance for both sides — under-reserving the vault.
  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (uint256 maxPayout, uint256 probabilityWad, uint256 expectedPayout, uint256 bodyVarianceScaled)
  {
    uint8 pick = _pick(gameData);
    maxPayout = (wager * MAX_PRICE_BPS) / BPS;
    expectedPayout = (wager * EXPECTED_RTP_BPS) / BPS;
    if (pick == 1) {
      probabilityWad = P_TOP_FIRST_WAD;
      bodyVarianceScaled = wager * wager * BODY_VAR_FIRST;
    } else {
      probabilityWad = P_TOP_SECOND_WAD;
      bodyVarianceScaled = wager * wager * BODY_VAR_SECOND;
    }
  }

  function onSessionStart(SessionContext calldata ctx) external pure returns (StepResult memory r) {
    uint8 pick = _pick(ctx.gameData);
    r.newGameState = abi.encode(uint256(pick));
    r.escrowDelta = 0;
    r.reservedProfitDelta = int256((ctx.escrowedStake * MAX_PRICE_BPS) / BPS - ctx.escrowedStake);
    r.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    r.requestRandomnessNow = true;
    r.payout = 0;
  }

  function onPlayerAction(SessionContext calldata, bytes calldata) external pure returns (StepResult memory) {
    revert HandicapGame__NoPlayerAction();
  }

  function onRandomness(SessionContext calldata ctx, bytes32 randomness) external pure returns (StepResult memory r) {
    uint256 board = _board(randomness);
    (uint256 grundy, uint256 moves) = _grundyAndMoves(board);
    uint256 tier = _tier(moves);
    uint8 pick = _committedPick(ctx);
    bool firstWins = grundy != 0;

    uint256 price = pick == 1 ? _priceFirst(tier) : _priceSecond(tier);
    bool won = pick == 1 ? firstWins : !firstWins;
    uint256 payout = won ? _payout(ctx.wagerBase, price) : 0;

    // Everything the page needs to draw the exact position the contract scored.
    r.newGameState = abi.encode(board, grundy, moves, tier, uint256(pick), payout);
    r.escrowDelta = 0;
    r.reservedProfitDelta = 0; // never release the reserve on the settling step
    r.nextPhase = SessionPhase.SETTLED;
    r.requestRandomnessNow = false;
    r.payout = payout;
  }

  function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
    return 0; // instant game: nothing is cashable mid-round
  }
}
