import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  exportEditedWorld,
  generateKeyPair,
  packManifestAndFiles,
  packWgif,
  sha256Hex,
  signManifest,
  signingHash,
  unpackWgif,
  utf8,
  validateWorld,
} from '../src/index.js';

const STATE_PATH = 'game-state.json';
const EDIT_AT = new Date('2026-11-16T20:00:00Z');

type CourtState = {
  version: string;
  objects: { ball: { position: number[] } };
};

/** Only the sender loads the fixture from disk. The receiver gets ZIP bytes alone. */
async function courtFromFixture() {
  const bytes = new Uint8Array(await readFile(new URL('../../../examples/court/court.wgif', import.meta.url)));
  const court = await unpackWgif(bytes);
  expect(court.report.ok).toBe(true);
  expect(court.manifest.entry.state).toBe(STATE_PATH);
  return court;
}

function movedBallState(court: Awaited<ReturnType<typeof courtFromFixture>>) {
  const original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(court.files[STATE_PATH])) as CourtState;
  expect(original.objects.ball.position).toHaveLength(3);
  const [x, y, z] = original.objects.ball.position;
  const position = [x! + 0.75, y!, z!];
  return { position, bytes: utf8(JSON.stringify({
    ...original,
    objects: { ...original.objects, ball: { ...original.objects.ball, position } },
  })) };
}

describe('Phase One criteria 6–7: export and portable reopen of the real court', () => {
  it('exports an editable game-state change and reopens solely from transferred bytes', async () => {
    const court = await courtFromFixture();
    expect(court.manifest.mode).toBe('editable');
    const { position, bytes: editedState } = movedBallState(court);
    const originalStateHash = court.manifest.files.find((f) => f.path === STATE_PATH)?.sha256;

    // This is the format writer used by player export: it recalculates hashes,
    // records edit provenance, and validates the serialized archive before return.
    const exported = await exportEditedWorld(
      { manifest: court.manifest, files: { ...court.files, [STATE_PATH]: editedState } },
      { by: 'roundtrip-test', note: 'move court ball', at: EDIT_AT },
    );

    // Simulate moving the saved .wgif to another device: hand the receiver only
    // an independent byte copy, never a path, parsed state or browser cache.
    const receivedBytes = Uint8Array.from(exported);
    const received = await unpackWgif(receivedBytes);
    expect(received.report.ok).toBe(true);
    expect(received.report.signature).not.toBe('invalid');
    expect((await validateWorld(received.manifest, received.files)).ok).toBe(true);

    const recovered = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(received.files[STATE_PATH])) as CourtState;
    expect(recovered.objects.ball.position).toEqual(position);
    expect(received.files[STATE_PATH]).toEqual(editedState);
    expect(received.manifest.files.find((f) => f.path === STATE_PATH)?.sha256)
      .not.toBe(originalStateHash);

    // Verify the entire manifest, not only the edited file. Every packaged
    // payload must still have its exact uncompressed size and SHA-256.
    for (const entry of received.manifest.files) {
      const payload = received.files[entry.path];
      expect(payload).toBeDefined();
      expect(entry.size).toBe(payload!.byteLength);
      expect(entry.sha256).toBe(await sha256Hex(payload!));
    }
    expect(received.files[court.manifest.entry.scene]).toEqual(court.files[court.manifest.entry.scene]);
    expect(received.files[court.manifest.entry.preview]).toEqual(court.files[court.manifest.entry.preview]);
    expect(received.manifest.modified).toBe('2026-11-16T20:00:00Z');
    expect(received.manifest.provenance?.history?.at(-1))
      .toMatchObject({ action: 'edit', by: 'roundtrip-test' });
  });

  it('uses the original signed view as the parent when a manifest spawn is edited', async () => {
    const court = await courtFromFixture();
    const keys = await generateKeyPair();
    const signedManifest = await signManifest(court.manifest, keys.secretKey);
    const original = await unpackWgif(packManifestAndFiles(signedManifest, court.files));
    expect(original.report.signature).toBe('valid');
    const parentHash = await signingHash(original.manifest);

    const newSpawn = { position: [2, 1.7, 7] as [number, number, number], lookAt: [0, 1.2, 0] as [number, number, number] };
    const changedManifest = { ...original.manifest, spawn: newSpawn };
    expect(await signingHash(changedManifest)).not.toBe(parentHash);

    const exported = await exportEditedWorld(
      { manifest: changedManifest, originalManifest: original.manifest, files: original.files },
      { by: 'spawn-roundtrip', at: EDIT_AT },
    );
    // A separate receiver starts from the archive bytes, not either manifest object.
    const received = await unpackWgif(Uint8Array.from(exported));
    expect(received.report.ok).toBe(true);
    expect(received.report.signature).toBe('absent');
    expect(received.manifest.signature).toBeUndefined();
    expect(received.manifest.spawn).toEqual(newSpawn);
    expect(received.manifest.provenance?.parent).toEqual({ id: original.manifest.id, signingHash: parentHash });
    expect(received.manifest.provenance?.history?.at(-1)).toMatchObject({ action: 'edit', by: 'spawn-roundtrip' });
    expect(received.files).toEqual(original.files);
  });

  it('refuses the same game-state edit when the court is locked', async () => {
    const court = await courtFromFixture();
    const lockedBytes = await packWgif({ ...court.manifest, mode: 'locked', signature: undefined }, court.files);
    const locked = await unpackWgif(lockedBytes);
    expect(locked.report.ok).toBe(true); // unsigned locked worlds are valid, but unverified
    expect(locked.manifest.mode).toBe('locked');

    const { bytes: editedState } = movedBallState(locked);
    await expect(exportEditedWorld(
      { manifest: locked.manifest, files: { ...locked.files, [STATE_PATH]: editedState } },
      { by: 'roundtrip-test', at: EDIT_AT },
    )).rejects.toMatchObject({ code: 'mode.locked' });
  });
});
