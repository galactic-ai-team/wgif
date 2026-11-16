import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackWgif } from '@wgif/format';
import { parseRulesModel } from '@wgif/ai';
import { buildCourtWgif } from '../src/world.js';

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

  it('committed court.wgif matches the generator', async () => {
    const committed = new Uint8Array(readFileSync(fileURLToPath(new URL('../court.wgif', import.meta.url))));
    expect(committed).toEqual(await buildCourtWgif());
  });
});
