# Picture worlds made with "Create from image"

Two worlds made in the player's creator (`apps/player/src/photo/`, see
`docs/notes/photo-component.md`), with the real depth model (Depth Anything V2 Small, int8 ONNX,
on WebAssembly in headless Chrome). Open either in the player, or drop the source picture on the
player to make your own.

| World | Bytes | Made from | Source licence |
| --- | --- | --- | --- |
| `street-3d.wgif` | 829,400 | "Lostwithiel Street showing Lifebuoy Cafe, Fowey, Cornwall - February 2024" by Mutney, 1024×843 JPEG scaled from the Commons original — <https://commons.wikimedia.org/wiki/File:Lostwithiel_Street_showing_Lifebuoy_Cafe,_Fowey,_Cornwall_-_February_2024.jpg> | CC0 1.0 |
| `bounce-3d.wgif` | 705,211 | A ball bouncing on a checkered floor at sunset, 480×300, 24 frames, 70 ms each — self-made: `python3 make-bounce-gif.py 480 300 24 bounce-480.gif` | CC0 1.0 (Galactic AI Team) |

Depth: `onnx-community/depth-anything-v2-small` revision `4472b7362082ad9968fee890ca0f1e5aca36b93d`
(Apache-2.0), computed in the browser; the model is not in the files, only its 8-bit depth map
(`assets/depth.png`). The worlds themselves (mesh, layout) are CC0 too. The files' own
`license` field says `LicenseRef-as-supplied`, which is what the creator writes for any picture,
since it cannot know the picture's licence; this table is the record for these two.
