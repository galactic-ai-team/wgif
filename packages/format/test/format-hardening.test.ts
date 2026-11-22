import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { runCli } from '../src/cli.js';
import {
  canonicalJson, DEFAULT_LIMITS, generateKeyPair, readContainer, sha256Hex, signingHash, unpackWgif,
  utf8, validateWorld, WgifReadError, type WgifManifest,
} from '../src/index.js';

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../../../tests/fixtures/${name}`, import.meta.url)));
}

const signedHashFixture: WgifManifest = {
  wgif: '0.1', id: 'test.world.1', title: 'Test', creator: { name: 'Tester' },
  created: '2026-11-15T00:00:00Z', mode: 'locked',
  entry: { scene: 'world.glb', preview: 'preview.png' },
  files: [
    { path: 'world.glb', sha256: '0'.repeat(64), size: 3, role: 'scene' },
    { path: 'preview.png', sha256: '1'.repeat(64), size: 2, role: 'preview' },
  ],
};

describe('JCS canonical signing vectors (no private keys in fixtures)', () => {
  it('sorts UTF-16 keys and preserves Unicode scalars without whitespace', async () => {
    const text = canonicalJson({ z: 1, a: ['é', null, 0], '😀': 'x' });
    expect(text).toBe('{"a":["é",null,0],"z":1,"😀":"x"}');
    expect(await sha256Hex(utf8(text))).toBe('3bf7541aecf44acefa6812b6dfb764ffaba200701aa48e759e1f6fb34cef0023');
  });
  it('pins signingHash to canonical view bytes, independent of files[] order', async () => {
    const hash = 'df6b5a1e479148beed1b32e97a70495b5e83392ff666da74aa34b4d898bd9e3e';
    expect(await signingHash(signedHashFixture)).toBe(hash);
    expect(await signingHash({ ...signedHashFixture, files: [...signedHashFixture.files].reverse() })).toBe(hash);
  });
  it('rejects non-JSON values and unpaired surrogates', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: '\ud800' })).toThrow(/surrogate/);
  });
});

describe('portable WGIF fixture corpus', () => {
  it('uses the bounded untrusted reader profile', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxEntries: 256,
      maxEntryBytes: 16 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    });
  });
  it('rejects 257 ZIP entries using the default 256-entry ceiling', () => {
    const archiveFiles: Zippable = { 'manifest.json': [utf8('{}'), { level: 0 }] };
    for (let i = 0; i < 256; i++) archiveFiles[`assets/${i}.bin`] = [utf8('x'), { level: 0 }];
    expect(() => readContainer(zipSync(archiveFiles))).toThrow(/entries/);
  });
  const good = ['good-minimal.wgif', 'good-layered.wgif'];
  const badArchives = [
    'bad-notzip.wgif', 'bad-truncated.wgif', 'bad-duplicate.wgif',
    'bad-missing-manifest.wgif', 'bad-compressed-manifest.wgif', 'bad-traversal.wgif', 'bad-prototype.wgif',
  ];
  const badSemantic = [
    'bad-hash.wgif', 'bad-json.wgif', 'bad-interactions.wgif', 'bad-state.wgif', 'bad-layer.wgif', 'bad-executable.wgif', 'bad-major.wgif',
  ];
  for (const name of good) it(`accepts ${name}`, async () => {
    const opened = await unpackWgif(await fixture(name));
    expect(opened.report.errors).toEqual([]);
    expect(opened.report.ok).toBe(true);
  });
  for (const name of badArchives) it(`rejects unsafe ZIP: ${name}`, async () => {
    await expect(unpackWgif(await fixture(name))).rejects.toBeInstanceOf(WgifReadError);
  });
  for (const name of badSemantic) it(`rejects invalid world: ${name}`, async () => {
    const opened = await unpackWgif(await fixture(name));
    expect(opened.report.ok).toBe(false);
    expect(opened.report.errors.length).toBeGreaterThan(0);
  });
  it('caps actual inflated output when matching ZIP headers lie about the uncompressed size', () => {
    const packed: Zippable = {
      'manifest.json': [utf8('{}'), { level: 0 }],
      'assets/large.bin': [new Uint8Array(4096).fill(65), { level: 9 }],
    };
    const bytes = Uint8Array.from(zipSync(packed));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Change both central and local originalSize, so structure checks pass
    // while the DEFLATE stream still expands to 4096 real bytes.
    let central = -1;
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const length = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + length));
      if (name === 'assets/large.bin') { central = i; break; }
    }
    expect(central).toBeGreaterThan(0);
    const local = view.getUint32(central + 42, true);
    view.setUint32(central + 24, 8, true);
    view.setUint32(local + 22, 8, true);

    const entryLimits = { maxEntries: 8, maxEntryBytes: 512, maxTotalBytes: 8192 };
    expect(() => readContainer(bytes, entryLimits)).toThrow(WgifReadError);
    try { readContainer(bytes, entryLimits); }
    catch (e) { expect(e).toMatchObject({ code: 'container.entrysize' }); }

    const totalLimits = { maxEntries: 8, maxEntryBytes: 8192, maxTotalBytes: 512 };
    expect(() => readContainer(bytes, totalLimits)).toThrow(WgifReadError);
    try { readContainer(bytes, totalLimits); }
    catch (e) { expect(e).toMatchObject({ code: 'container.totalsize' }); }
  });
  it('rejects a decompression budget exceeded before extraction', async () => {
    const bytes = await fixture('good-minimal.wgif');
    expect(() => readContainer(bytes, { maxEntries: 1, maxEntryBytes: 1024, maxTotalBytes: 1024 }))
      .toThrow(/entries|too large|limit/);
  });
});

describe('payload and capability validation', () => {
  it('reports structured interaction schema errors', async () => {
    const opened = await unpackWgif(await fixture('good-minimal.wgif'));
    const files = { ...opened.files, 'interactions.json': utf8('{"version":"0.1","camera":{"spawn":[0]}}') };
    const report = await validateWorld(opened.manifest, files);
    expect(report.errors.map((x) => x.code)).toContain('payload.interactions.minItems');
  });
  it('refuses external GLB URI references without fetching them', async () => {
    const opened = await unpackWgif(await fixture('good-minimal.wgif'));
    const json = utf8(JSON.stringify({ asset: { version: '2.0' }, buffers: [
      { uri: 'https://example.invalid/should-not-fetch.bin', byteLength: 0 },
    ] }));
    const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(32);
    padded.set(json);
    const bytes = new Uint8Array(20 + padded.length);
    const dv = new DataView(bytes.buffer);
    bytes.set(utf8('glTF'), 0);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, bytes.length, true);
    dv.setUint32(12, padded.length, true);
    bytes.set(utf8('JSON'), 16);
    bytes.set(padded, 20);
    const report = await validateWorld(opened.manifest, { ...opened.files, 'world.glb': bytes });
    expect(report.errors.map((x) => x.code)).toContain('scene.external-uri');
  });
  it('warns rather than silently ignoring unknown required capabilities', async () => {
    const opened = await unpackWgif(await fixture('good-minimal.wgif'));
    const report = await validateWorld({ ...opened.manifest, requires: ['scene.glb', 'future.gravity'] }, opened.files);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((x) => x.code)).toContain('requires.unknown');
  });
  it('recognizes a valid Ed25519 signature as different from creator trust', async () => {
    const { secretKey } = await generateKeyPair();
    expect(secretKey.byteLength).toBe(32);
    // No baked-in private test key and no claim that a signature authenticates a real-world person.
  });
});

describe('offline CLI', () => {
  it('validates and inspects fixture worlds', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'wgif-cli-'));
    try {
      const path = join(temp, 'world.wgif');
      await writeFile(path, await fixture('good-minimal.wgif'));
      const output: string[] = [];
      expect(await runCli(['validate', path], (s) => output.push(s))).toBe(0);
      expect(output.join('\n')).toContain('PASS');
      expect(await runCli(['inspect', path], (s) => output.push(s))).toBe(0);
      expect(output.join('\n')).toContain('test.fixture.world');
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  it('packs a folder then signs with a local key file (never logged)', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'wgif-cli-'));
    try {
      const folder = join(temp, 'source');
      await mkdir(folder);
      const original = await unpackWgif(await fixture('good-minimal.wgif'));
      await writeFile(join(folder, 'manifest.json'), JSON.stringify(original.manifest));
      for (const [path, bytes] of Object.entries(original.files)) await writeFile(join(folder, path), bytes);
      const packed = join(temp, 'packed.wgif');
      const signed = join(temp, 'signed.wgif');
      const seedFile = join(temp, 'local-seed');
      const messages: string[] = [];
      expect(await runCli(['pack', folder, '--out', packed], (s) => messages.push(s))).toBe(0);
      const { secretKey } = await generateKeyPair();
      await writeFile(seedFile, secretKey, { mode: 0o600 });
      expect(await runCli(['sign', packed, '--key', seedFile, '--out', signed], (s) => messages.push(s))).toBe(0);
      const world = await unpackWgif(new Uint8Array(await readFile(signed)));
      expect(world.report.signature).toBe('valid');
      expect(messages.join('\n')).not.toContain(Buffer.from(secretKey).toString('hex'));
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
