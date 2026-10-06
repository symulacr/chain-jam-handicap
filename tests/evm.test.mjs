#!/usr/bin/env node
/**
 * HANDICAP — EVM-level tests: the contract deployed on a real EVM.
 *
 *   node --test tests/evm.test.mjs      (wired into `npm test`)
 *
 * The other test files assert the SHIPPED source and the model; this one compiles the contract,
 * deploys it on a throwaway anvil and drives the real host lifecycle, so a source/model↔bytecode
 * divergence cannot pass silently. It covers:
 *   - the committed side round-trips through gameState for BOTH picks (1 = FIRST, 2 = SECOND);
 *   - the settled payout equals the model's fair price for that side and tier;
 *   - quoteRiskParams decodes the side (doc invariant 3) and returns that side's top-tier
 *     probability and body variance (doc invariant 4) — the F3 fix, checked on chain;
 *   - a bad pick in gameData reverts; a 1-byte / absent gameState falls back to gameData.
 *
 * Needs `solc`, `anvil`, `cast`. When any is absent this file FAILS with a non-zero exit rather than
 * skipping: a green run that never deployed the contract is indistinguishable from a real one.
 * Scratch only: a private anvil on a non-harness port; no repo file is written; the deploy key is
 * read from anvil's own output (no key material in the repo).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outcome } from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.HANDICAP_EVM_PORT || 8997);
const RPC = `http://127.0.0.1:${PORT}`;
const CTX_SIG = '(uint256,address,address,uint256,uint256,uint256,uint32,bytes,bytes)';
// board 3 (top bytes); a dealt position the model scores on both sides.
const WORD = '0x0000000300000000000000000000000000000000000000000000000000000000';
const WAGER = 1000000000000000000n;

// The toolchain gate FAILS, it never skips. This suite compiles the shipped contract, deploys it to
// an anvil and settles both sides of a real position; without it the money path never executed, and
// reporting that as a pass is the defect (it hid a green CI run of nothing). Each missing binary is
// named with the one command that installs it so the failure is actionable on the machine it happens
// on.
const INSTALL_HINT = {
  solc: 'npm install -g solc@0.8.34   (or https://docs.soliditylang.org/en/latest/installing-solidity.html)',
  anvil: 'curl -L https://foundry.paradigm.xyz | bash && foundryup   (adds ~/.foundry/bin to PATH)',
  cast: 'same Foundry install as anvil — cast ships in the same tarball',
};
const missing = ['solc', 'anvil', 'cast'].filter((b) => spawnSync(b, ['--version'], { encoding: 'utf8' }).error);
if (missing.length) {
  console.error('handicap EVM tests — TOOLCHAIN MISSING');
  console.error('  This suite is REQUIRED: it compiles contracts/HandicapGame.sol, deploys it to an');
  console.error('  anvil and settles both sides of a real position. Without it the money path never');
  console.error('  executed, so this run is a failure, not a skip.');
  for (const b of missing) console.error(`  missing: ${b}\n    install: ${INSTALL_HINT[b]}`);
  process.exit(1);
}

const sh = (bin, args) => { const r = spawnSync(bin, args, { encoding: 'utf8' }); if (r.error) throw r.error; return r; };
const w = (hex, i) => { const t = String(hex).replace(/^0x/, '').slice(i * 64, i * 64 + 64); return t.length === 64 ? BigInt('0x' + t) : 0n; };
const ethCall = async (to, data) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
const ctx = (gameData, gameState) =>
  `(1,0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002,` +
  `${WAGER},${WAGER},0,0,${gameData},${gameState})`;
const enc = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-evm-'));
const c = sh('solc', ['--optimize', '--bin', '-o', out, path.join(ROOT, 'contracts', 'HandicapGame.sol')]);
assert.equal(c.status, 0, `solc compiles HandicapGame.sol: ${c.stderr}`);
const bin = fs.readFileSync(path.join(out, 'HandicapGame.bin'), 'utf8').trim();

const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '31344'], { stdio: ['ignore', 'pipe', 'ignore'] });
let bootLog = '';
anvil.stdout.on('data', (d) => { bootLog += d.toString(); });
const waitKey = async () => {
  for (let i = 0; i < 100; i++) { const m = bootLog.match(/\b0x[0-9a-fA-F]{64}\b/); if (m) return m[0]; await new Promise(r => setTimeout(r, 100)); }
  return null;
};
let addr = null;
test('handicap EVM tests', async (t) => {
  t.after(() => { anvil.kill('SIGKILL'); fs.rmSync(out, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !addr; i++) { try { await ethCall('0x0000000000000000000000000000000000000000', '0x'); } catch { await new Promise(r => setTimeout(r, 100)); } }
  const key = await waitKey();
  assert.ok(key, 'anvil printed its development private key');
  const receipt = JSON.parse(sh('cast', ['send', '--json', '--rpc-url', RPC, '--private-key', key, '--create', bin]).stdout);
  addr = receipt.contractAddress || (receipt.receipt && receipt.receipt.contractAddress);
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/, 'deployed');

  const model = outcome(WORD); // { board, grundy, moves, tier, firstWins, priceFirstBps, priceSecondBps }

  await t.test('the committed side round-trips and pays the model price, for both picks', async () => {
    for (const pick of [1, 2]) {
      const start = await ethCall(addr, sh('cast', ['calldata', `onSessionStart(${CTX_SIG})`, ctx('0x0' + pick, '0x')]).stdout.trim());
      assert.equal(Number(w(start, 8)), pick, `onSessionStart committed pick ${pick}`);

      const settled = await ethCall(addr, sh('cast', ['calldata', `onRandomness(${CTX_SIG},bytes32)`, ctx('0x00', enc(pick)), WORD]).stdout.trim());
      assert.equal(Number(w(settled, 8)), model.board, 'board');
      assert.equal(Number(w(settled, 9)), model.grundy, 'grundy');
      assert.equal(Number(w(settled, 10)), model.moves, 'moves');
      assert.equal(Number(w(settled, 11)), model.tier, 'tier');
      assert.equal(Number(w(settled, 12)), pick, 'committed pick in newGameState');

      const won = pick === 1 ? model.firstWins : !model.firstWins;
      const price = pick === 1 ? model.priceFirstBps : model.priceSecondBps;
      const expectedPayout = won ? (WAGER * BigInt(price)) / 10000n : 0n;
      assert.equal(w(settled, 13), expectedPayout, `payout for pick ${pick}`);
    }
  });

  await t.test('quoteRiskParams is side-aware and matches the documented body variance (F3)', async () => {
    const qf = await ethCall(addr, sh('cast', ['calldata', 'quoteRiskParams(uint256,bytes)', WAGER.toString(), '0x01']).stdout.trim());
    const qs = await ethCall(addr, sh('cast', ['calldata', 'quoteRiskParams(uint256,bytes)', WAGER.toString(), '0x02']).stdout.trim());
    assert.equal(w(qf, 0), (WAGER * 80492n) / 10000n, 'maxPayout');
    assert.equal(w(qf, 1), 33599853515625000n, 'FIRST top-tier probability (8808/2^18)');
    assert.equal(w(qf, 3), WAGER * WAGER * 290760843382584294n, 'FIRST body variance (tier 4 removed)');
    assert.equal(w(qs, 1), 10044097900390625n, 'SECOND top-tier probability (2633/2^18)');
    assert.equal(w(qs, 3), WAGER * WAGER * 2734806412979170708n, 'SECOND body variance (tier 0 removed)');
    assert.notEqual(w(qf, 1), w(qs, 1), 'the two sides must not share one probability');
    assert.notEqual(w(qf, 3), w(qs, 3), 'the two sides must not share one body variance');
  });

  await t.test('boundaries: a bad pick reverts; a 1-byte / empty gameState falls back to gameData', async () => {
    const bad = await (async () => { try { await ethCall(addr, sh('cast', ['calldata', `onSessionStart(${CTX_SIG})`, ctx('0x03', '0x')]).stdout.trim()); return false; } catch { return true; } })();
    assert.ok(bad, 'gameData=0x03 must revert (BadPick)');
    for (const gs of ['0x02', '0x']) {
      const r = await ethCall(addr, sh('cast', ['calldata', `onRandomness(${CTX_SIG},bytes32)`, ctx('0x02', gs), WORD]).stdout.trim());
      assert.equal(Number(w(r, 12)), 2, `gameState ${gs} should fall back to gameData pick 2`);
    }
  });
});