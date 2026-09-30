#!/usr/bin/env node
// Builds dist/blockville.html: the whole game as ONE self-contained file.
//
//   node tools/build-dist.mjs
//
// 1. Bundles src/iconworker.js (menu-icon Web Worker) to an IIFE string and
//    exposes it as globalThis.BV_ICON_WORKER_SRC (icons.js turns it into a Blob
//    worker, since a single file can't point a Worker at ./iconworker.js).
// 2. Bundles src/main.js to a minified IIFE and inlines it into index.html in
//    place of the module <script> tag.
//
// Gotcha: the splice uses the FUNCTION form of String.replace — a minified
// bundle contains `$&` etc., which the string form would expand (that once
// truncated the inline script and hung the page on "Loading your city…").
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = (entry) => execFileSync('npx', ['--yes', 'esbuild', entry, '--bundle', '--minify', '--format=iife',
  '--log-level=error'], { cwd: root, maxBuffer: 1 << 30 }).toString();

const worker = esbuild('src/iconworker.js');
const main = esbuild('src/main.js');
const bundle = 'globalThis.BV_ICON_WORKER_SRC=' + JSON.stringify(worker).replace(/<\/script/gi, '<\\/script') + ';\n' + main;
if (/<\/script/i.test(bundle)) throw new Error('bundle contains </script — would truncate the inline script');

const shell = readFileSync(join(root, 'index.html'), 'utf8');
const marker = '<script type="module" src="./src/main.js"></script>';
if (!shell.includes(marker)) throw new Error('index.html module script tag not found');
const html = shell.replace(marker, () => '<script>\n' + bundle + '\n</script>');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/blockville.html'), html);
const closes = (html.match(/<\/script/gi) || []).length;
if (closes !== 1) throw new Error('expected exactly 1 </script in dist, found ' + closes);
console.log('dist/blockville.html', (html.length / 1e6).toFixed(2) + ' MB');
