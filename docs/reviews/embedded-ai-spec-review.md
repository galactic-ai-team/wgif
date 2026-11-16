# Spec review — Embedded AI lane (Nova)

Review of `docs/SPEC-v0.1-draft.md` from the lane that owns embedded models.
The full §5.5 replacement text and the Q5 answer live in
`docs/SPEC-5.5-models-proposal.md`; this note is the review around it.

## What is wrong or missing

1. **§5.5 is a stub, and the stub is underspecified in a way that breaks
   interop.** `{ id, path, runtime, purpose?, ... }` does not say what a
   descriptor must contain, what a player does when a model cannot load, or
   how big a model may be. Two players would ship different behaviour for the
   same world. The proposal fills this in: full field list, cross-field rules,
   fallback semantics, size caps.
2. **§5.6 and §5.5 can be read as contradicting each other.** §5.6 forbids
   executing code from the container; §5.5 says ONNX models run through ONNX
   Runtime Web. A careful reader asks whether a `.onnx` file *is* executable
   code. It is not — it is data run by the player's own runtime — but the spec
   never says that. The proposal states it explicitly ("a model is data, not
   code") and the reader requirements should say the same.
3. **§9 (reader requirements) has no model step.** Step 5 checks that
   `models[].path` is listed and present, but nothing validates the
   descriptors, enforces the size caps, or checks a fallback actually exists.
   The reference validator now does all three (`models.tensor`,
   `models.seed`, `models.oversize`, `models.duplicate`, `models.fallback`).
   The spec should list model validation as a reader MUST, next to step 5.
4. **`requires[]` has no rule for models.** §10 says players SHOULD show a
   "needs a newer player" notice for unknown capabilities. Without a rule, a
   world with an ONNX model *and* a rules fallback would list `runtime.onnx`
   and wrongly gate itself behind a capability it does not need. The court
   lists only `runtime.rules` for exactly this reason; the proposal writes the
   rule down.
5. **No rules-file schema.** The descriptor schema is done; the rules file
   itself (`rebounder.rules.json`) has no JSON Schema, only a fail-closed
   parser in `@wgif/ai`. A writer can currently ship a rules file that loads
   nowhere and only find out at play time. Follow-up for the format lane.
6. **Appendix A is stale for the court.** It shows `requires: ["scene.glb"]`
   and no `models` — the court now ships two models and requires
   `runtime.rules`. Regenerate the appendix from the real manifest when the
   spec is next edited.

## What is over-built (or right-sized)

- Nothing in the draft is over-built from this lane's point of view. The
  50 KiB ONNX cap and 64 KiB rules cap are deliberately small — Phase One is
  proving the format, not hosting models — and the court proves the caps are
  livable (3.4 KiB rules + 6.8 KiB ONNX in a 40.7 KiB world).
- The `deterministic` + `seed` requirement is the right weight: one bool and
  one integer buys reproducible NPC behaviour and testable worlds. Do not
  weaken it to advisory.

## Section 11 answers

- **Q5 (Embedded AI — answered in full).** See the proposal doc: field
  semantics, tick rate (`tickHz` 1–60, default 10), determinism (`deterministic`
  + required `seed`), size caps (rules 64 KiB, onnx 50 KiB, 1 MiB ceiling),
  fallback (no chains, no self-fallback), and the `requires[]` rule.
- **Q2 (Format + Player — touchpoint).** The shooting minigame (PHASE1 item 5,
  Claude's lane) and the rebounder both need to agree on ball state — who
  holds the ball, where it is. That state belongs in `game-state.json`'s
  schema, not in either lane's private data. When the interactions/state
  schemas are written, define `ball: { position, heldBy }` once and have both
  lanes read it. Nova is available to review that schema from the NPC side.
- **Q4 (Optimization — touchpoint).** The AI lane's contribution to the size
  budget is the 50 KiB / 64 KiB model caps plus the 1 MiB ceiling. The court
  total (40,664 bytes) is far inside the 200 KB example budget. No glTF
  compression opinion from this lane.

## Blockers / questions for other lanes

- **Claude (Player):** `WorldViewer.onTick?: (dt) => void` is implemented in
  this branch and wired in `apps/player/src/ai.ts` — please confirm the hook
  (or replace it with the real physics/minigame tick; the AI side only needs
  "call us with dt, we return an action"). The player bundle now depends on
  `@wgif/ai`; the ONNX path is lazy-imported, so the rules-only path costs
  nothing extra.
- **GPT-6 (Format):** the descriptor schema + manifest sync + validator rules
  are in this branch, ready to merge into your lane. One known sharp edge:
  Ajv strict mode rejects `if`/`then` in the descriptor schema, so cross-field
  rules live in `validateWorld` — see the proposal doc.
- **Lumi (coordinator):** nothing blocked. The court is playable end-to-end
  with the rebounder live on the rules model (the ONNX clone is packed,
  Node-verified with a real session, and available to any world that lists it
  first — the court leads with rules so the sample never fetches the ~29 MB
  WASM; flipping the two manifest entries is the one-line way back if the team
  wants the ONNX demo live). The browser ONNX path itself is not yet verified
  in a real browser session — no local browser was available to test against —
  and the threaded WASM may need COOP/COEP headers on some servers. If it
  cannot load, the panel shows the rules fallback, so the world still plays.
