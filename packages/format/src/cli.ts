#!/usr/bin/env node
/** Offline WGIF CLI. Keys are read only from explicitly supplied local files. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packManifestAndFiles, packWgif, unpackWgif } from './container.js';
import { signManifest } from './signing.js';
import type { ManifestInput, WgifFiles } from './types.js';
import { fromHex, isSafePath } from './util.js';

const help = `WGIF v0.1 offline CLI
  wgif validate <file.wgif>
  wgif inspect <file.wgif>
  wgif pack <directory> [--out <file.wgif>]
  wgif sign <file.wgif> --key <local-seed-file> [--out <file.wgif>]
Local signing seed file: 32 raw bytes OR 64 hexadecimal characters. Never commit or share it.`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`${name} needs a value`);
  return args[i + 1];
}
async function payloadDir(dir: string): Promise<WgifFiles> {
  const files: WgifFiles = {};
  async function visit(path: string): Promise<void> {
    for (const d of await readdir(join(dir, path), { withFileTypes: true })) {
      const rel = path ? `${path}/${d.name}` : d.name;
      if (!isSafePath(rel)) throw new Error(`unsafe payload path: ${rel}`);
      if (d.isSymbolicLink()) throw new Error(`symlinks are forbidden: ${rel}`);
      if (d.isDirectory()) { await visit(rel); continue; }
      if (!d.isFile()) throw new Error(`unsupported directory entry: ${rel}`);
      if (rel === 'manifest.json') continue;
      files[rel] = new Uint8Array(await readFile(join(dir, rel)));
    }
  }
  await visit('');
  return files;
}
async function localSeed(path: string): Promise<Uint8Array> {
  const raw = await readFile(path);
  if (raw.length === 32) return new Uint8Array(raw);
  const hex = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return fromHex(hex);
  throw new Error('signing key file must contain 32 raw seed bytes or 64 hex characters');
}

/** Returns an exit status, suitable for programmatic usage and Vitest. */
export async function runCli(args: string[], output: (s: string) => void = console.log): Promise<number> {
  const [cmd, input] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { output(help); return 0; }
  if (!['inspect', 'validate', 'pack', 'sign'].includes(cmd) || !input || input.startsWith('--')) {
    output(help); return 2;
  }
  try {
    if (cmd === 'pack') {
      const dir = resolve(input);
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ManifestInput;
      if (manifest.signature) throw new Error('pack refuses an existing signature: pack the unsigned world, then use wgif sign');
      const files = await payloadDir(dir);
      const archive = await packWgif(manifest, files);
      const opened = await unpackWgif(archive);
      if (!opened.report.ok) throw new Error(opened.report.errors.map((e) => `${e.code}: ${e.message}`).join('; '));
      const target = resolve(option(args, '--out') ?? `${dir}.wgif`);
      await writeFile(target, archive);
      output(`packed ${target} (${archive.length} bytes)`);
      return 0;
    }
    const source = await readFile(resolve(input));
    const world = await unpackWgif(source);
    if (cmd === 'validate') {
      output(`WGIF validation: ${world.report.ok ? 'PASS' : 'FAIL'} (${basename(input)})`);
      for (const e of [...world.report.errors, ...world.report.warnings]) output(`${e.level}: ${e.code}: ${e.message}`);
      output(`signature: ${world.report.signature}`);
      return world.report.ok ? 0 : 1;
    }
    if (cmd === 'inspect') {
      output(JSON.stringify({ id: world.manifest.id, title: world.manifest.title, version: world.manifest.wgif,
        mode: world.manifest.mode, entries: world.manifest.entry, requires: world.manifest.requires ?? [],
        files: world.manifest.files.length, signature: world.report.signature, valid: world.report.ok }, null, 2));
      return world.report.ok ? 0 : 1;
    }
    if (!world.report.ok) throw new Error('cannot sign invalid WGIF: run wgif validate first');
    const keyPath = option(args, '--key');
    if (!keyPath) throw new Error('sign requires --key <local-seed-file>');
    const seed = await localSeed(resolve(keyPath));
    const signed = await signManifest(world.manifest, seed);
    const target = resolve(option(args, '--out') ?? input.replace(/\.wgif$/i, '') + '.signed.wgif');
    const archive = packManifestAndFiles(signed, world.files);
    const verified = await unpackWgif(archive);
    if (!verified.report.ok || verified.report.signature !== 'valid') throw new Error('post-signature verification failed');
    await writeFile(target, archive);
    output(`signed ${target} (verification: valid)`);
    return 0;
  } catch (e) {
    output(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
