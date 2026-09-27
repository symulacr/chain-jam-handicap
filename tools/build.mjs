#!/usr/bin/env node
/**
 * Assemble `dist/` from the source tree.
 *
 *   npm run build        # -> node tools/build.mjs
 *
 * No bundler and no runtime dependency: this is a straight copy that preserves the relative
 * layout the page expects.
 *
 *   index.html          -> dist/index.html
 *   game/               -> dist/game/            (../game/model.mjs resolves from src/app.js)
 *   src/                -> dist/src/             (app.js + styles.css + sdk/guest.mjs)
 *   public/*            -> dist/ root            (game.manifest.json, og-image.png, _headers, ...)
 *
 * The page therefore works served from `dist/` as a plain static tree, with the same relative
 * paths it uses in the source tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Recursively copy `srcRel` to `destRel` under dist/, creating parents as needed. */
function copyInto(srcRel, destRel) {
  const from = path.join(ROOT, srcRel);
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      copyInto(path.posix.join(srcRel, e.name), path.posix.join(destRel, e.name));
    }
    return;
  }
  const to = path.join(DIST, destRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyInto('index.html', 'index.html');
copyInto('game', 'game');
copyInto('src', 'src');
copyInto('public', ''); // public/* lands at the dist root the page's relative paths expect

// Report what was assembled, with sizes.
let count = 0;
let bytes = 0;
function report(rel) {
  const abs = path.join(DIST, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      report(path.posix.join(rel, e.name));
    }
    return;
  }
  count += 1;
  bytes += st.size;
  console.log(`  ${String(st.size).padStart(8)}  dist/${rel}`);
}
console.log('build: dist/ assembled');
report('');
console.log(`\n${count} files, ${bytes} bytes raw`);
