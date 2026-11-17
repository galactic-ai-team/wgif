import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackWgif } from '@wgif/format';
import { parseRulesModel } from '@wgif/ai';
import { COURT, rimCenter } from '../src/court.js';
import { buildCourtWgif, courtManifest, interactions } from '../src/world.js';

describe('example court', () => {
  it('builds a valid, reproducible .wgif', async () => {
    const a = await buildCourtWgif();
    const b = await buildCourtWgif();
    expect(a).toEqual(b);
    const world = await unpackWgif(a);
    expect(world.report.errors).toEqual([]);
    expect(world.manifest.mode).toBe('editable');
    const glb = world.files['world.glb']!;
    expect(new TextDecoder().decode(glb.subarray(0, 4))).toBe('glTF');
    expect(Array.from(world.files['preview.png']!.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    // interactions.json is the world the rebounder plays in (ball, rims,
    // shootout): the packed file must contain it, and the manifest entry
    // must resolve to it.
    expect(world.manifest.entry.interactions).toBe('interactions.json');
    const interactions = JSON.parse(new TextDecoder().decode(world.files['interactions.json']!)) as {
      objects: { id: string }[];
      minigames: { id: string }[];
    };
    expect(interactions.objects.map((o) => o.id)).toContain('ball');
    expect(interactions.minigames.map((m) => m.id)).toContain('shootout');
    expect(a.byteLength).toBeLessThan(200 * 1024);
  });

  it('ships the rebounder models, and the descriptor matches the rules file', async () => {
    const world = await unpackWgif(await buildCourtWgif());
    const models = world.manifest.models ?? [];
    expect(models.map((m) => m.id)).toEqual(['rebounder-rules', 'rebounder-mlp']); // manifest order is load order: rules live, ONNX packaged
    const rules = models.find((m) => m.id === 'rebounder-rules')!;
    const mlp = models.find((m) => m.id === 'rebounder-mlp')!;
    expect(rules.runtime).toBe('rules');
    expect(mlp.runtime).toBe('onnx');
    expect(mlp.fallback).toBe('rebounder-rules');
    expect(mlp.inputs?.[0]?.shape).toEqual([1, 14]);
    expect(mlp.outputs?.[0]?.shape).toEqual([1, 3]);
    expect(world.manifest.requires).toContain('runtime.rules');
    // The descriptor is the contract: it must agree with the rules file it points to.
    const parsed = parseRulesModel(world.files['models/rebounder.rules.json']!);
    expect(rules.tickHz).toBe(parsed.tickHz);
    expect(rules.seed).toBe(parsed.seed);
    // The packed rules file carries the fix: in the chase state, an
    // out-of-bounds ball is given up on before a near ball is picked up.
    const chaseOn = parsed.states.chase!.on.map((t) => t.when);
    expect(chaseOn.indexOf('ball_out_of_bounds')).toBeLessThan(chaseOn.indexOf('ball_near'));
    expect(world.files['models/rebounder-mlp.onnx']!.byteLength).toBeLessThanOrEqual(51200);
  });

  it('frames the hoop, backboard, and free-throw line inside a 390x844 portrait FOV from spawn', () => {
    const manifest = courtManifest();
    const inter = interactions();
    expect(manifest.spawn).toBeDefined();
    expect(inter.camera.spawn).toEqual(manifest.spawn!.position);
    expect(inter.camera.lookAt).toEqual(manifest.spawn!.lookAt);

    const pos = manifest.spawn!.position;
    const target = manifest.spawn!.lookAt!;

    const fx = target[0] - pos[0];
    const fy = target[1] - pos[1];
    const fz = target[2] - pos[2];
    const fLen = Math.hypot(fx, fy, fz);
    const fwd: [number, number, number] = [fx / fLen, fy / fLen, fz / fLen];
    const rxRaw = -fwd[2];
    const rzRaw = fwd[0];
    const rLen = Math.hypot(rxRaw, rzRaw) || 1;
    const right: [number, number, number] = [rxRaw / rLen, 0, rzRaw / rLen];
    const up: [number, number, number] = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];

    const aspect = 390 / 844;
    const tanHalfVfov = Math.tan((60 * Math.PI) / 360);
    const tanHalfHfov = tanHalfVfov * aspect;

    const projectNdc = (p: [number, number, number]) => {
      const dx = p[0] - pos[0], dy = p[1] - pos[1], dz = p[2] - pos[2];
      const cz = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
      expect(cz).toBeGreaterThan(0.5);
      const cx = dx * right[0] + dy * right[1] + dz * right[2];
      const cy = dx * up[0] + dy * up[1] + dz * up[2];
      return { ndcX: cx / (cz * tanHalfHfov), ndcY: cy / (cz * tanHalfVfov) };
    };

    const hoop = rimCenter(1);
    const backboardTop: [number, number, number] = [hoop[0] + COURT.rimRadius + 0.15, hoop[1] + 0.975, 0];
    const freeThrowCenter: [number, number, number] = [COURT.length / 2 - 5.8, 0.012, 0];

    for (const pt of [hoop, backboardTop, freeThrowCenter]) {
      const { ndcX, ndcY } = projectNdc(pt);
      expect(Math.abs(ndcX)).toBeLessThanOrEqual(0.85);
      expect(Math.abs(ndcY)).toBeLessThanOrEqual(0.85);
    }
  });

  it('committed court.wgif matches the generator', async () => {
    const committed = new Uint8Array(readFileSync(fileURLToPath(new URL('../court.wgif', import.meta.url))));
    expect(committed).toEqual(await buildCourtWgif());
  });
});
