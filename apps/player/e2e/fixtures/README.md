# Test pictures for the image → 3D creator

| File | What | Source | Licence |
| --- | --- | --- | --- |
| `street-256.png` | "Lostwithiel Street showing Lifebuoy Cafe, Fowey, Cornwall - February 2024", by Mutney, scaled to 256 px and reduced to 128 colours | <https://commons.wikimedia.org/wiki/File:Lostwithiel_Street_showing_Lifebuoy_Cafe,_Fowey,_Cornwall_-_February_2024.jpg> | CC0 1.0 (public domain dedication) |
| `bounce-160.gif` | A ball bouncing on a checkered floor at sunset, 10 frames, 160×100 | Self-made by the Galactic AI Team: `python3 ../../../../examples/photo/make-bounce-gif.py 160 100 10 bounce-160.gif` (Pillow) | CC0 1.0 |

The e2e test (`../image3d.e2e.mjs`) uploads both. The example worlds in `examples/photo/`
were made from the 1024 px version of the same photo and the 480×300, 24-frame version of the GIF.
