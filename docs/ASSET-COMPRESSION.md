# glTF compression for WGIF v0.1 (Q4)

Owner: Dee (OPTIMIZATION). Status: harness landed, **numbers pending a run** —
`npm run lab:compression` prints the table below with real byte counts. The
figures marked *EST* are published ranges, not measurements from this repo.

## What we tested

`scripts/asset-compression-lab.ts` rewrites the court's `world.glb` through:

1. `dedup() + weld() + prune()` — index sharing, unused accessor removal
2. `quantize()` → `KHR_mesh_quantization`
3. `meshopt()` → `EXT_meshopt_compression`

## Results

| Variant | Bytes | vs baseline | gzip | Player decoder cost |
|---|---:|---:|---:|---|
| baseline | `<run>` | — | `<run>` | 0 |
| weld+dedup+prune | `<run>` | `<run>` | `<run>` | 0 (build-time only) |
| +KHR_mesh_quantization | `<run>` | `<run>` | `<run>` | **0** — GLTFLoader handles it |
| +EXT_meshopt_compression | `<run>` | `<run>` | `<run>` | meshopt decoder, `<run>` gzip |

Decoder cost is measured from `node_modules`, not quoted from a blog post.

## Expected magnitudes (EST — replace with the run)

| Technique | Vertex data | Decoder JS (gzip) | Decode time | Verdict |
|---|---|---|---|---|
| `KHR_mesh_quantization` | −50…−60% | 0 KiB | ~0 ms | **always on** |
| `EXT_meshopt_compression` | −55…−75% on top of quantize | ~10–15 KiB | 1–3 ms per 100 k tris | **on, if the world is big enough** |
| `KHR_draco_mesh_compression` | −60…−80% | ~110–130 KiB | 5–15 ms + worker | no for v0.1 |
| `KHR_texture_basisu` (KTX2) | textures −75% | ~90–120 KiB | 2–10 ms | v0.2 |
| `EXT_texture_webp` | textures −25…−35% | **0** | ~0 | **yes** |

At the court's ~30 KB none of this matters. It starts to matter at 300 KB+,
which is where real worlds will land. Build the mechanism now, keep the
reference world uncompressed so it stays trivially reproducible.

## Recommendation for Q4 (extensions a v0.1 player MUST support)

**MUST — zero decoder cost, natively supported by three.js GLTFLoader:**

- `KHR_mesh_quantization`
- `EXT_texture_webp`

**MUST, and this is the one that needs a spec rule:**

- `EXT_meshopt_compression` — for a ~10–15 KiB gzip decoder it is the only
  technique that meaningfully moves a textured world under 1 MiB. Make it
  required for "Phase One compliant player". For this to be safe, the
  manifest needs a **`requiredExtensions: string[]`** field so a player that
  can't decode fails with a human message instead of a blank canvas.

**MAY / v0.2:** `KHR_draco_mesh_compression`, `KHR_texture_basisu`. Both cost
30–40% of the entire player JS budget for one format each. They only pay for
themselves above ~2 MiB of geometry or textures, and our whole world budget
is 1 MiB.

**Do not require, ever, in the base layer:** anything that needs a network
fetch at runtime (external decoder CDNs). Offline is the product.