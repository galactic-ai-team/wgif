/** PR-safe technical checks for WGIF v0.1: reproducible examples + version hold. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMITTED_COURT_SHA256 = '31559eb9b4d10b3b4b5ba7dbc7f5b1746587e3ea8400b2704bfc84dd09f39dd2';
const DRAFT = '0.1.0-draft.0';
const PACKAGES = ['format', 'ai'] as const;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The release bump stays blocked until the owner gate is explicitly approved. */
export function versionRuleIssues(
  ownerApproved: boolean,
  packageVersions: Record<string, string>,
  lockVersions: Record<string, string>,
): string[] {
  const errors: string[] = [];
  for (const name of PACKAGES) {
    if (packageVersions[name] !== lockVersions[name]) errors.push(`${name}: package and lockfile versions differ`);
    if (!ownerApproved && packageVersions[name] !== DRAFT)
      errors.push(`${name}: owner gate is open; version must stay ${DRAFT}`);
    if (ownerApproved && ![DRAFT, '0.1.0'].includes(packageVersions[name] ?? ''))
      errors.push(`${name}: unexpected release version ${packageVersions[name]}`);
  }
  return errors;
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
}

function check(): void {
  const freeze = readFileSync(join(ROOT, 'docs/FREEZE-v0.1.md'), 'utf8');
  const approved = /^- \[[xX]\] \*\*Owner decision:\*\*/m.test(freeze);
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version: string }>;
  };
  const packageVersions: Record<string, string> = {};
  const lockVersions: Record<string, string> = {};
  for (const name of PACKAGES) {
    packageVersions[name] = (JSON.parse(readFileSync(join(ROOT, `packages/${name}/package.json`), 'utf8')) as { version: string }).version;
    lockVersions[name] = lock.packages[`packages/${name}`]?.version ?? '(missing)';
  }
  const versions = versionRuleIssues(approved, packageVersions, lockVersions);
  if (versions.length) throw new Error(versions.join('; '));

  const court = 'examples/court/court.wgif';
  const courtHash = sha256(readFileSync(join(ROOT, court)));
  if (courtHash !== COMMITTED_COURT_SHA256)
    throw new Error(`${court}: SHA-256 changed from pinned baseline; review and intentionally update pin (${courtHash})`);

  // Two separate deterministic builds: do not confuse a clean git diff with proof
  // that the intentionally gitignored generated world can be reproduced.
  const generated = join(ROOT, 'examples/court/court.gen.wgif');
  const generate = (): string => {
    run('npx', ['--no-install', 'tsx', 'examples/court/src/pack-court.ts']);
    return sha256(readFileSync(generated));
  };
  const first = generate();
  const second = generate();
  if (first !== second) throw new Error(`court.gen.wgif is not deterministic: ${first} != ${second}`);

  // Read the archives using the built, offline format CLI; do not rely on ZIP CRC alone.
  const cli = join(ROOT, 'packages/format/dist/src/cli.js');
  for (const path of [court, 'examples/court/court.gen.wgif']) {
    run(process.execPath, [cli, 'validate', join(ROOT, path)]);
    run(process.execPath, [cli, 'inspect', join(ROOT, path)]);
  }
  console.log(`WGIF technical freeze PASS: committed=${courtHash} generated=${second}; versions held/synced`);
  console.log('Owner, offline/browser acceptance, normative freeze, and release evidence are still separate gates.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(); }
  catch (error) { console.error(`WGIF technical freeze BLOCKED: ${(error as Error).message}`); process.exitCode = 1; }
}
