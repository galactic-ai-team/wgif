# WGIF vs the incumbents (DRAFT)

A short, honest comparison of WGIF against the three formats a creator is
most likely to reach for instead: Khronos interactive glTF
(`KHR_interactivity`), X3D/VRML, and USDZ. No fake claims: anything WGIF
has not built yet is labelled **planned**, and the places the incumbents
win are stated first.

| | WGIF | KHR_interactivity (glTF) | X3D / VRML | USDZ |
| --- | --- | --- | --- | --- |
| One portable file | yes (`.wgif`, a ZIP) | yes (`.glb`) | yes (XML or binary) | yes (a ZIP of USD) |
| Embedded offline AI / NPCs | yes (rules + tiny ONNX, no runtime WASM) | no | no | no |
| Persistent memory (a world that evolves) | **planned** (SPEC §10 DRAFT) | no | no | no |
| Signing + creator permissions | yes (Ed25519, locked / editable modes) | no in-format model | no | no in-format model |
| Plays on a phone | yes (browser PWA, offline) | yes (web viewers) | yes (web viewers) | yes (iOS Quick Look / AR) |
| Ecosystem (Blender, three.js, authoring tools) | one reference player | the industry standard | ISO standard, dated tooling | Apple / ARKit |

## KHR_interactivity (interactive glTF)

**What it does better today.** It is glTF. That is the whole advantage:
Blender exports it, three.js and Babylon.js run it, every 3D tool reads
it, and a creator can open a `.glb` in a dozen viewers without installing
anything WGIF-specific. Its behaviour graph (events, actions, variables)
is a real, ratified Khronos extension, and it covers the interactive
cases WGIF's `interactions.json` covers — click to animate, a switch
that opens a door — with a bigger spec and more examples. If the goal is
"make a 3D object that does something when I click it, and have it work
everywhere", glTF wins today.

**Where WGIF wins.** KHR_interactivity has no NPCs and no memory. A glTF
world cannot carry a rebounder that fetches the ball, learns where your
misses land, and waits there next time — that is WGIF's embedded-AI lane
(see below). It also has no in-format signing or creator permissions: a
`.glb` does not say who made it, whether it may be edited, or whether a
copy is authentic. And it has no image-to-world creator flow: WGIF
turns a photo or GIF into a playable world on the phone itself.

## X3D / VRML

**What it does better today.** It is an ISO standard with a richer scene
model than WGIF's: a full scene graph, sensors (touch, proximity,
visibility), interpolators, and scripting. A world built in X3D can
express more kinds of 3D content than WGIF's deliberately bounded scene
(a photo/GIF-derived world, a handcrafted court, a sample world). If the
goal is "a complex, scripted 3D scene", X3D's ceiling is higher.

**Where WGIF wins.** X3D's web tooling is dated and its viewers are
thin compared with glTF's, so the richer ceiling is harder to reach.
It has no embedded AI, no persistent memory, and no signing or creator
permissions. And its creator flow is "author a scene in a 3D tool";
WGIF's is "take a photo, get a world" — a lower floor for someone who
has never opened Blender.

## USDZ

**What it does better today.** It is Apple's AR format, and on an iPhone
that matters more than any spec: tap a `.usdz` and it opens in Quick
Look, in AR, with no app and no browser. USD (the format inside) has
the richest scene graph of the four, and the ARKit ecosystem around it
is real. If the goal is "show this object in AR on an iPhone", USDZ
wins today, and nothing WGIF does in a browser matches Quick Look's
zero-friction open.

**Where WGIF wins.** USDZ is Apple-first: outside iOS its viewers are
thin, and it is an AR *object* format, not a *world* format — it does
not carry a game, a Shootout, or an NPC. It has no embedded AI, no
persistent memory, and no in-format signing or creator permissions.
WGIF plays in a browser on any phone (Android included), offline, and
carries the world, the game, the NPC and the creator's permissions in
one file.

## Nova's half: the AI / NPC angle

None of the three incumbents ships intelligence inside the file. Their
interactivity is a behaviour graph (glTF), sensors and routes (X3D), or
nothing at all (USDZ): the world reacts when the player acts, and is
inert otherwise. WGIF's embedded AI is a different thing — a small,
offline model that *plays*: the court rebounder chases a loose ball,
picks it up, carries it back and passes it, at 10 Hz, with no network,
no runtime WASM, and a rules twin as fallback if the ONNX clone cannot
run. The models are data, not code (SPEC §6): a rules state machine or
a 6.8 KB MLP, declared in the manifest, validated before inference,
stepped no faster than its declared `tickHz`. That is a capability
none of the three has, and it is built, not planned — it is live in
the player today.

The gap inside WGIF's own AI is honesty, not hype: the models are tiny
and task-specific (a rebounder, not a general agent), the ONNX clone
agrees with the rules model at 88.5% on the agreement grid, and a new
behaviour (a drone that drops an orb, a gallery guide that walks to the
painting you look at) still needs a new behaviour in the runtime — the
rules language has move / hold / pass, not drop or go-to-a-named-target.
The AI wins where the task fits in a state machine; it does not win
where the task needs a general agent.

## Nova's half: the creator-experience angle

WGIF's creator flow is the shortest of the four: take a photo or a GIF
on your phone, and the player builds a 3D world from it (depth model,
mesh, a room or a landscape) that you can walk around in, share as one
file, and open on another device offline. None of the three has an
equivalent "create from image" path — their creator flow starts in a
3D authoring tool. WGIF also tells the creator, up front, what the
world will cost: a size budget (1 MiB per world, per-entry caps) that
the tooling enforces, so a world that fits the budget plays on a phone.
And the creator's permissions travel with the file (locked / editable,
signed), so a shared world says what may be done with it.

The honest limit is that WGIF's creator tools are one reference player,
not an ecosystem. A creator who already works in Blender can export
glTF in one click and publish anywhere; a WGIF creator uses the WGIF
player. That is the gap that matters most (see below).

## The top 3 gaps that matter most

1. **Ecosystem and tooling.** glTF has Blender, three.js, Babylon and
   every 3D tool; USD has Apple's pipeline; X3D has an ISO standard.
   WGIF has one reference player. Until a `.wgif` opens in a tool a
   creator already uses, WGIF is a format you have to adopt, not one
   you already have. This is the gap to close first.
2. **Viewer ubiquity.** USDZ opens in iOS Quick Look (built into every
   iPhone); glTF opens in dozens of viewers. WGIF needs its own player
   (a PWA). The PWA works offline and on any phone, which is real, but
   it is still a destination the user has to reach, not an OS-level
   open. The iOS share/open path (PR #32) narrows this; it does not
   close it.
3. **Scene richness.** glTF, USD and X3D are general 3D scene formats:
   complex geometry, materials, animation, skinning. WGIF's scene is
   deliberately bounded (a photo-derived world, a handcrafted court, a
   sample world) so it fits the 1 MiB budget and plays on a phone.
   That bound is a feature for portability and a limit for
   expressiveness — a creator who needs a full 3D production will hit
   WGIF's ceiling before they hit glTF's or USD's.

## Dee's half (TODO)

*Dee to add: the format / portability angle (ZIP envelope, validation,
reproducibility, the byte-metered reader), the storage / security angle
(IndexedDB saves, the adversarial limits, what a hostile file cannot
do), and the performance angle (initial JS budget, the deferred
creator, the offline PWA) — plus any gaps she sees that Nova missed.*
