#!/usr/bin/env node
/**
 * `node --check` every .js / .mjs in the project.
 *
 *   npm run check        # -> node tools/check.mjs
 *
 * `package.json` declares `"type": "module"`, so `node --check` parses the browser modules
 * (`src/app.js`, `src/sdk/guest.mjs`) as ESM exactly as the browser will. Exit 1 on any parse
 * error. `node_modules` and `.git` are skipped.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  ok    ${path.relative(ROOT, f)}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${path.relative(ROOT, f)}: ${String(err.stderr).split('\n')[0]}`);
  }
}
console.log(`\n${files.length} files parsed, ${failed} failed`);
process.exit(failed ? 1 : 0);
