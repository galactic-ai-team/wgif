/** Explicit, fail-closed v0.1.0 release preflight. Run only for a release candidate or tag. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGlbExtensions } from '../src/glbExtensions.js';
import { readContainer } from '../src/container.js';

type Json = Record<string, unknown>;
export const RELEASE_TAG = 'v0.1.0';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GATES = [
  ['owner', 'Owner decision'],
  ['normative', 'Normative docs'],
  ['capabilities', 'Capability behavior'],
  ['offline', 'Offline acceptance'],
  ['security', 'Format/security'],
  ['examples', 'Examples/reproducibility'],
  ['smoke', 'CI/release smoke'],
  ['versions', 'Package versions/lock'],
  ['release', 'Release commit/tag'],
] as const;
const ARTIFACTS = ['examples/court/court.wgif', 'examples/court/court.gen.wgif'] as const;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const loadJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Checklist headings are a contract: adding a gate cannot silently bypass CI. */
export function auditChecklist(source: string): string[] {
  const errors: string[] = [];
  const lines = source.split(/\r?\n/).filter((line) => /^- \[[ xX]\] \*\*/.test(line));
  if (lines.length !== GATES.length) errors.push(`FREEZE checklist has ${lines.length} gates; expected ${GATES.length}`);
  for (const [, label] of GATES) {
    if (!lines.some((line) => line.startsWith(`- [x] **${label}:**`) || line.startsWith(`- [X] **${label}:**`)))
      errors.push(`FREEZE gate incomplete or renamed: ${label}`);
  }
  return errors;
}

/** Manual evidence is a reviewed attestation, not a technical substitute for offline/browser testing. */
export function auditEvidence(value: unknown): string[] {
  const issues: string[] = [];
  if (!isObject(value) || value.release !== RELEASE_TAG || value.formatVersion !== '0.1' || !isObject(value.gates))
    return ['release evidence must declare release=v0.1.0, formatVersion=0.1 and gates'];
  for (const [id] of GATES) {
    const record = value.gates[id];
    if (!isObject(record) || record.complete !== true || typeof record.evidence !== 'string' ||
      record.evidence.trim().length < 10 || /TODO|TBD|PLACEHOLDER/i.test(record.evidence))
      issues.push(`missing completion/evidence for release gate: ${id}`);
  }
  if (!isObject(value.artifacts)) return [...issues, 'release evidence missing artifacts SHA-256 map'];
  for (const path of ARTIFACTS) {
    const expected = value.artifacts[path];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))
      issues.push(`missing 64-digit lowercase SHA-256 for ${path}`);
  }
  return issues;
}

function auditRelease(root = ROOT): string[] {
  const problems: string[] = [];
  const check = (condition: boolean, message: string): void => { if (!condition) problems.push(message); };
  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
  const readObject = (...parts: string[]): Json => {
    const file = join(root, ...parts);
    if (!existsSync(file)) { problems.push(`missing ${parts.join('/')}`); return {}; }
    try { const result = loadJson(file); if (isObject(result)) return result; }
    catch { /* handled below */ }
    problems.push(`invalid JSON object: ${parts.join('/')}`);
    return {};
  };

  problems.push(...auditChecklist(read('docs', 'FREEZE-v0.1.md')));
  const evidence = readObject('docs', 'release', `${RELEASE_TAG}-evidence.json`);
  problems.push(...auditEvidence(evidence));

  const manifestSchema = readObject('packages', 'format', 'schema', 'manifest.v0.1.schema.json');
  const properties = isObject(manifestSchema.properties) ? manifestSchema.properties : {};
  check(!Object.hasOwn(properties, 'requiredExtensions'), 'manifest.requiredExtensions must not exist (use requires[])');
  for (const file of [
    'interactions.v0.1.schema.json', 'game-state.v0.1.schema.json',
    'layer.v0.1.schema.json', 'model-descriptor.v0.1.schema.json',
  ]) check(existsSync(join(root, 'packages/format/schema', file)), `missing frozen schema ${file}`);
  const spec = read('docs', 'SPEC-v0.1-draft.md');
  check(!/\*\*Status:\*\* proposed release candidate|\*\*Status:\*\*.*not ratified/i.test(spec),
    'normative spec still marked as an unapproved release candidate');

  const lock = readObject('package-lock.json');
  const lockPackages = isObject(lock.packages) ? lock.packages : {};
  for (const name of ['format', 'ai']) {
    const pkg = readObject('packages', name, 'package.json');
    const locked = lockPackages[`packages/${name}`];
    check(pkg.version === '0.1.0', `@wgif/${name} package version must be 0.1.0`);
    check(isObject(locked) && locked.version === '0.1.0', `package-lock.json must record packages/${name}@0.1.0`);
  }

  const artifactHashes = isObject(evidence.artifacts) ? evidence.artifacts : {};
  const cli = join(root, 'packages/format/dist/src/cli.js');
  check(existsSync(cli), 'compiled CLI missing: run npm run build first');
  for (const artifact of ARTIFACTS) {
    const full = join(root, artifact);
    if (!existsSync(full)) { problems.push(`missing generated release artifact: ${artifact}`); continue; }
    const bytes = new Uint8Array(readFileSync(full));
    check(artifactHashes[artifact] === sha256(bytes), `artifact hash mismatch: ${artifact}`);
    try {
      const { manifestJson, files } = readContainer(bytes);
      if (!isObject(manifestJson) || !isObject(manifestJson.entry) ||
        typeof manifestJson.entry.scene !== 'string' || !Array.isArray(manifestJson.requires)) {
        problems.push(`${artifact}: malformed manifest`);
      } else {
        const scene = files[manifestJson.entry.scene];
        if (!scene) problems.push(`${artifact}: missing scene GLB`);
        else for (const issue of checkGlbExtensions(scene, manifestJson.requires as string[], true))
          problems.push(`${artifact}: ${issue.code}: ${issue.message}`);
        check(manifestJson.wgif === '0.1', `${artifact}: manifest version must be 0.1`);
      }
    } catch (error) { problems.push(`${artifact}: ${(error as Error).message}`); }
    if (existsSync(cli)) for (const command of ['validate', 'inspect']) {
      const result = spawnSync(process.execPath, [cli, command, full], { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) problems.push(`${artifact}: compiled CLI ${command} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
  }

  const gitRef = process.env.GITHUB_REF;
  if (gitRef?.startsWith('refs/tags/')) {
    check(gitRef === `refs/tags/${RELEASE_TAG}`, `wrong release tag ref: ${gitRef}`);
    try {
      const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      check(actual === process.env.GITHUB_SHA, 'tag checkout SHA differs from GITHUB_SHA');
    } catch { problems.push('git HEAD could not be verified for release tag'); }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const issues = auditRelease();
    if (issues.length) {
      console.error(`WGIF ${RELEASE_TAG} FREEZE BLOCKED (${issues.length} gates/checks):\n${issues.map((x) => ` - ${x}`).join('\n')}`);
      process.exitCode = 1;
    } else console.log(`WGIF ${RELEASE_TAG}: release preflight PASS; owner must still authorize publishing/tagging`);
  } catch (error) {
    console.error(`WGIF ${RELEASE_TAG} FREEZE BLOCKED: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
