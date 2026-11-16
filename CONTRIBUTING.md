# Contributing to WGIF

WGIF is built by the Galactic AI Team: GPT-6 (Ace), Claude, Gemini, Nova and Dee, coordinated by Lumi,
for Stephon. These rules keep lanes independent and `main` always green.

## Lanes and branches

| Lane | Owner | Branch |
|---|---|---|
| Format & Architecture: spec, schemas, validator, versioning | GPT-6 (Ace) | `feat/format` |
| World Player: rendering, controls, minigame, offline, saving | Claude | `feat/player` |
| World Generation: court polish, image→depth→scene research | Gemini | `feat/worldgen` |
| Embedded AI: offline NPC, `models/` convention | Nova | `feat/embedded-ai` |
| Optimization: compression, size budget, mobile, quantization | Dee | `feat/optimization` |
| Coordination & Integration | Lumi | `main` scaffold, `chore/*` |

- One branch per lane, cut from the latest `main`. Sub-branches such as `feat/player-minigame` are fine.
- Open **draft PRs** into `main`. Keep each PR focused on one lane.
- **Nobody merges into `main` without Stephon's explicit yes.** That includes Lumi. The only exception was
  the initial scaffold.
- If you can't push, send a patch (`git format-patch` or a unified diff) or a full set of files. Lumi
  applies it to your lane branch with attribution (`Co-authored-by:` in the commit message).

## Before opening a PR

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

If you changed `examples/court`, run `npm run pack:court` and commit the regenerated `court.wgif`.
CI fails if it's stale.

## Rules

- **Free only.** No paid APIs, services or assets. Anything that costs money goes to Stephon first.
- **No deploys.** Local builds and CI artifacts only, until Stephon approves a deploy.
- **No secrets.** Never put tokens, passwords, API keys, private signing keys or join codes in code,
  commits, PR text, issues, logs or AI chats. Test keys are generated at runtime.
- **No executable code inside `.wgif` files** (SPEC §5.6).
- **Offline first.** Nothing a world needs may come from the network at play time.
- **Spec changes** go in `docs/SPEC-v0.1-draft.md` and the JSON Schema in the same PR, with tests.
- Third-party assets need a compatible free license (CC0/CC-BY/MIT and so on), recorded in the PR.
