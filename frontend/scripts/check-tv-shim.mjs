#!/usr/bin/env node
/**
 * Compares the enum values declared in the hand-written type shim against the
 * licensed declarations.
 *
 * The shim exists so pull requests can typecheck without licensed material
 * (see vendor/tradingview/types-shim/charting_library.d.ts). Structural drift
 * is caught by typechecking the app against the shim. Enum VALUES are not:
 * these are `declare enum`s with no runtime representation, so nothing at
 * either type level or run time notices when the shim claims
 * `OrderStatus.Working = 6` and the real package says otherwise. The app
 * mirrors those numbers into TV_ORDER_STATUS / TV_ORDER_TYPE / TV_SIDE /
 * TV_PARENT_TYPE and sends them to the library, so a wrong one is a silently
 * wrong order status or a bracket that never renders.
 *
 * No-op when the licensed package is absent — there is nothing to compare
 * against on a pull request, which is the whole reason the shim is there.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const REAL = path.join(repoRoot, 'vendor', 'tradingview', 'types', 'charting_library.d.ts');
const SHIM = path.join(repoRoot, 'vendor', 'tradingview', 'types-shim', 'charting_library.d.ts');

if (!existsSync(REAL)) {
  console.warn('licensed declarations absent — nothing to compare the shim against; skipping.');
  process.exit(0);
}
if (!existsSync(SHIM)) {
  console.error(`FATAL: shim missing at ${path.relative(repoRoot, SHIM)}`);
  process.exit(1);
}

/** Extracts `enum Name { A = 1, B = 2 }` members, keyed by enum then member. */
function readEnums(file) {
  const source = readFileSync(file, 'utf8');
  const enums = new Map();
  // `declare enum X {` or `export declare enum X {` — capture to the closer.
  const pattern = /(?:export\s+)?declare\s+enum\s+(\w+)\s*\{([^}]*)\}/g;
  for (const [, name, body] of source.matchAll(pattern)) {
    const members = new Map();
    for (const [, member, value] of body.matchAll(/(\w+)\s*=\s*(-?\d+)/g)) {
      members.set(member, Number(value));
    }
    if (members.size > 0) enums.set(name, members);
  }
  return enums;
}

const real = readEnums(REAL);
const shim = readEnums(SHIM);

if (shim.size === 0) {
  console.error('FATAL: no enums parsed from the shim — has its format changed?');
  process.exit(1);
}

const problems = [];
for (const [name, shimMembers] of shim) {
  const realMembers = real.get(name);
  if (!realMembers) {
    problems.push(`${name}: declared in the shim but not found in the licensed types`);
    continue;
  }
  for (const [member, shimValue] of shimMembers) {
    const realValue = realMembers.get(member);
    if (realValue === undefined) {
      problems.push(`${name}.${member}: in the shim, absent from the licensed types`);
    } else if (realValue !== shimValue) {
      problems.push(`${name}.${member}: shim says ${shimValue}, licensed types say ${realValue}`);
    }
  }
}

if (problems.length > 0) {
  console.error('The type shim disagrees with the licensed declarations:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nThese numbers are mirrored into the TV_* constants and sent to the library.' +
      '\nFix the shim (and any TV_* constant derived from it) before merging.',
  );
  process.exit(1);
}

const checked = [...shim].map(([n, m]) => `${n}(${m.size})`).join(', ');
console.warn(`✓ shim enum values match the licensed declarations: ${checked}`);
