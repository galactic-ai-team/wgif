# Phase One — Minimum Viable WGIF

> Don't start with complex AI generation. First prove the format works.

**Goal:** a functional single-file interactive world that can be shared, opened, played, modified
when permitted, and saved offline. The first environment is handcrafted: a basketball court.

Legend: `[x]` done on `main` · `[~]` proof only / partial · `[ ]` open. Owner lanes are in brackets.

- [x] **1. Packaged into a single `.wgif` file.** `examples/court/court.wgif` is built by `npm run pack:court`, reproducible byte for byte, and checked in CI. [Lumi → GPT-6 to finalize]
- [x] **2. Contains a standard preview image or GIF.** `preview.png` (top-down court) is shown in the player sidebar. Animated GIF preview: [Gemini/Dee]
- [x] **3. Opens through the WGIF Player.** `apps/player` opens a file via the file picker or drag-and-drop, validates it, and shows errors. [Claude]
- [~] **4. Basic camera movement and exploration.** Orbit (mouse/touch) and first-person walk (pointer-lock + WASD, desktop only). Touch walk controls and collisions are open. [Claude]
- [ ] **5. A working basketball shooting minigame.** Interaction data is declared in `interactions.json`, but the player doesn't run it yet. [Claude, with Nova for the rebounder NPC]
- [ ] **6. Runs fully offline once the player is installed.** The player makes no network calls for worlds, but there's no PWA/service worker yet. [Claude, Dee]
- [~] **7. Supports editable and locked creator modes.** The format layer is done: modes, ed25519 signing/verification, and `exportEditedWorld()` refusing locked worlds, all tested. The player UI for it is open. [GPT-6, Claude]
- [~] **8. Saves modifications and exports a new `.wgif`.** The library export with history and provenance is done and tested. Player save/export UI and local state saving are open. [Claude, GPT-6]
- [ ] **9. Can be moved to another device and opened.** To verify on a real second device (phone + desktop) once 6 and 8 land. [Lumi, Dee]

## Exit checks (all must pass before Phase One is called done)

- [ ] CI green on `main`: lint, typecheck, tests, build, reproducible sample, size report.
- [ ] The court opens on desktop Chrome/Firefox/Safari and on one phone, with the network off.
- [ ] Play a shootout, edit something (e.g. move the ball spawn or add a layer), export, re-open the export on another device, and see the edit and the provenance history.
- [ ] A locked, signed copy shows "signature valid" and offers no edit tools. A tampered copy shows "invalid".
- [ ] `docs/SPEC-v0.1-draft.md` reviewed by all five lanes and approved by Stephon as v0.1.
