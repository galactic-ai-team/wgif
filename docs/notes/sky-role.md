# Player convention: a world's own sky (`extras.wgif.role: "sky"`)

Non-normative (not part of SPEC v0.1; Format lane to decide whether to adopt it).

A world can bring its own sky as an ordinary mesh, typically an inward-facing sphere textured
with an equirectangular 360° photo (see `examples/worlds/src/rooftop.ts`). Mark the glTF node with
`"extras": {"wgif": {"role": "sky"}}`. The proof player then treats it as scenery at infinity:

- it is left out of the world bounds that frame the orbit overview, the preview snapshot and the
  sun's shadow box (`apps/player/src/sky.ts`), so a 150 m sky sphere does not shrink the world;
- it neither casts nor receives shadows, and is never merged with other static meshes.

Give the material a black base colour and the photo as its emissive map so the scene lights do not
tint it. A player that ignores the hint still draws the sphere, just framed less tightly, so the
convention needs no `requires[]` capability.
