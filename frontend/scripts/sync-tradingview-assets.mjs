#!/usr/bin/env node
/**
 * Copies the LICENSED TradingView package from a local source into this repo.
 *
 * We do not download TradingView assets. The library is distributed under a
 * per-licensee agreement; the only legitimate source is the package the
 * licensee already holds. This script therefore COPIES from a configured local
 * path and never fetches anything from the network.
 *
 * Source resolution order:
 *   1. --source=<path>
 *   2. $VITE_TRADINGVIEW_SOURCE_DIR
 *   3. $TRADINGVIEW_SOURCE_DIR
 *   4. ../trading-view-integration  (the known local reference checkout)
 *
 * Destinations:
 *   public/charting_library/   → served at /charting_library/ (library_path)
 *   public/datafeeds/          → the bundled UDF helpers, if present
 *   vendor/tradingview/types/  → the .d.ts files the app compiles against
 *
 * Both destinations are git-ignored. Vendoring licensed binaries into a repo
 * that may be cloned by anyone without a licence would breach the agreement;
 * CI restores them from a private artifact instead (see docs/operations/runbook.md).
 *
 * `--check` verifies the assets are present and exits non-zero if not, so a
 * Docker or CI build FAILS LOUDLY rather than silently shipping a terminal
 * with no chart.
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const sourceArg = args.find((a) => a.startsWith('--source='))?.slice('--source='.length);

const SOURCE_CANDIDATES = [
  sourceArg,
  process.env.VITE_TRADINGVIEW_SOURCE_DIR,
  process.env.TRADINGVIEW_SOURCE_DIR,
  path.resolve(repoRoot, '..', 'trading-view-integration'),
].filter(Boolean);

const DEST_LIBRARY = path.join(repoRoot, 'public', 'charting_library');
const DEST_DATAFEEDS = path.join(repoRoot, 'public', 'datafeeds');
const DEST_TYPES = path.join(repoRoot, 'vendor', 'tradingview', 'types');

/** Files the app cannot run without. */
const REQUIRED_LIBRARY_FILES = ['charting_library.js', 'charting_library.standalone.js'];
const TYPE_FILES = [
  ['charting_library/charting_library.d.ts', 'charting_library.d.ts'],
  ['charting_library/datafeed-api.d.ts', 'datafeed-api.d.ts'],
  ['charting_library/broker-api.d.ts', 'broker-api.d.ts'],
];

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function verify() {
  const missing = [];

  if (!(await isDirectory(DEST_LIBRARY))) {
    missing.push(`${path.relative(repoRoot, DEST_LIBRARY)}/ (directory absent)`);
  } else {
    const present = new Set(await readdir(DEST_LIBRARY));
    for (const file of REQUIRED_LIBRARY_FILES) {
      if (!present.has(file)) missing.push(`${path.relative(repoRoot, DEST_LIBRARY)}/${file}`);
    }
  }

  for (const [, destName] of TYPE_FILES) {
    if (!existsSync(path.join(DEST_TYPES, destName))) {
      missing.push(`${path.relative(repoRoot, DEST_TYPES)}/${destName}`);
    }
  }

  return missing;
}

async function main() {
  if (checkOnly) {
    const missing = await verify();
    if (missing.length > 0) {
      fail(
        `Licensed TradingView assets are missing:\n\n` +
          missing.map((m) => `      - ${m}`).join('\n') +
          `\n\n    Run:  npm run tv:sync -- --source=/path/to/licensed/package\n` +
          `    This build cannot fall back to a public TradingView widget.`,
      );
    }
    console.warn('  ✓ Licensed TradingView assets present.');
    return;
  }

  let source = null;
  for (const candidate of SOURCE_CANDIDATES) {
    const resolved = path.resolve(candidate);
    if (await isDirectory(path.join(resolved, 'charting_library'))) {
      source = resolved;
      break;
    }
  }

  if (!source) {
    fail(
      `Could not find a licensed TradingView package.\n\n` +
        `    Looked in:\n` +
        SOURCE_CANDIDATES.map((c) => `      - ${path.resolve(c)}`).join('\n') +
        `\n\n    Point the script at your licensed copy:\n` +
        `      npm run tv:sync -- --source=/path/to/package\n` +
        `      (or set VITE_TRADINGVIEW_SOURCE_DIR)`,
    );
  }

  console.warn(`  Source: ${source}`);

  // Copy the runtime library. The source package is NEVER modified.
  await rm(DEST_LIBRARY, { recursive: true, force: true });
  await mkdir(path.dirname(DEST_LIBRARY), { recursive: true });
  await cp(path.join(source, 'charting_library'), DEST_LIBRARY, {
    recursive: true,
    dereference: true,
  });
  console.warn(`  ✓ charting_library → ${path.relative(repoRoot, DEST_LIBRARY)}`);

  // Datafeed helpers are optional — we use our own gateway datafeed.
  const datafeedsSource = path.join(source, 'datafeeds');
  if (await isDirectory(datafeedsSource)) {
    await rm(DEST_DATAFEEDS, { recursive: true, force: true });
    await cp(datafeedsSource, DEST_DATAFEEDS, { recursive: true, dereference: true });
    console.warn(`  ✓ datafeeds → ${path.relative(repoRoot, DEST_DATAFEEDS)}`);
  }

  // Type declarations are what the app compiles against.
  await mkdir(DEST_TYPES, { recursive: true });
  let typesCopied = 0;
  for (const [relative, destName] of TYPE_FILES) {
    const from = path.join(source, relative);
    if (!existsSync(from)) continue;
    await cp(from, path.join(DEST_TYPES, destName), { dereference: true });
    typesCopied++;
  }

  // The Trading Platform (not Advanced Charts) additionally ships this.
  const terminalTypes = path.join(source, 'trading_terminal.d.ts');
  if (existsSync(terminalTypes)) {
    await cp(terminalTypes, path.join(DEST_TYPES, 'trading_terminal.d.ts'), { dereference: true });
    typesCopied++;
  }
  console.warn(`  ✓ ${typesCopied} type declaration file(s) → ${path.relative(repoRoot, DEST_TYPES)}`);

  // Record what was synced so a build failure can be diagnosed later.
  await writeFile(
    path.join(repoRoot, 'vendor', 'tradingview', 'SYNC_INFO.json'),
    `${JSON.stringify({ source, syncedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  const missing = await verify();
  if (missing.length > 0) {
    fail(`Sync completed but required files are still missing:\n${missing.join('\n')}`);
  }

  console.warn('\n  ✓ TradingView assets ready.\n');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
