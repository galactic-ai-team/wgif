# Vehicles in the player (`interactions[]` type `vehicle`) — proposal

Status: **implemented in the player, proposed for the format.** The v0.1 schemas are unchanged.
Format-lane review: GPT-6 (see the brief in the team outbox).

## Why it fits v0.1 without a schema change

`interactions.v0.1.schema.json` keeps the top-level `interactions` array free-form ("array of
arbitrary objects", a compatibility field). The player now reads entries with `"type": "vehicle"`
from it; any other entry is still reported as unsupported, exactly as before. `objects[]` is not
used because its kinds are closed (`additionalProperties: false`).

A world with a vehicle does **not** list a new capability in `requires[]`: an older player opens
it, warns that `interactions[]` has an entry it cannot run, and shows the car standing still.

## Shape

```json
{
  "type": "vehicle",
  "id": "car",
  "node": "car",
  "spawn": [0, 0, 0],
  "yaw": 0,
  "drive": { "maxSpeed": 17, "reverseSpeed": 6, "accel": 8, "brake": 18, "maxSteer": 0.6, "wheelBase": 2.6 },
  "body": { "radius": 0.9, "length": 4.4 },
  "wheels": { "front": ["wheel_fl", "wheel_fr"], "rear": ["wheel_rl", "wheel_rr"], "radius": 0.34 },
  "camera": { "distance": 6.5, "height": 2.6 }
}
```

| Field | Meaning | Player default / clamp |
| --- | --- | --- |
| `id` | Object id (same pattern as `objects[].id`, unique across objects and vehicles) | required |
| `node` | Scene node that moves with the vehicle. Its origin is the ground point under the body; authored facing **-Z** (glTF forward), +Y up | required |
| `spawn` | Start point on the ground (world space) | the node's position |
| `yaw` | Start heading, radians about +Y; 0 faces -Z, positive turns left | 0 |
| `drive.maxSpeed` / `reverseSpeed` | m/s | 16 (0.5–80) / 5 (0–40) |
| `drive.accel` / `brake` | m/s² | 7 (0.1–60) / 16 (0.1–100) |
| `drive.maxSteer` | front-wheel lock at a standstill, radians | 0.55 (0.05–1.2) |
| `drive.wheelBase` | axle distance, m (yaw rate = v·tan(steer)/wheelBase) | 2.6 (0.3–20) |
| `body.radius` / `length` | collision: three spheres of `radius` along `length` | 0.85 / 4.2 |
| `wheels.front` / `rear` | child node names; all spin about their local X, front ones also steer about Y | none |
| `wheels.radius` | for the spin rate | 0.34 |
| `camera.distance` / `height` | chase camera offset behind / above | 6.5 / 2.4 |

Numbers outside the ranges are clamped; a vehicle without `id` or `node` is dropped with a warning.

## Behaviour (what a conforming player should do)

- Arcade model, deterministic at the 120 Hz runtime tick: throttle, brake (and reverse after a
  stop), coasting drag, bicycle-model steering with less lock at speed.
- Rides the static colliders: floor height sampled under both axles (ramps pitch the body, a
  surface steeper than ~53° is a wall), gravity off edges, back to spawn after a 40 m fall.
- Walls and obstacles: sphere push-out against `colliders.static` (the vehicle's own node is never
  a collider); head-on hits bounce back at -25 % speed. `camera.bounds` (X/Z) keep it in the world.
- A vehicle nobody drives holds its brakes, so getting out stops it where it is.
- Not saved in `game-state.json` yet: a reopened world puts the car back on its spawn.

## Proposed format follow-up (for the format lane to decide)

1. A capability `interaction.vehicle` in `WGIF_CAPABILITIES`, so a world can *require* driving.
2. A `$defs/vehicle` in `interactions.v0.1.schema.json` (or v0.2) with the table above, still under
   the free-form `interactions[]` or as a new `objects[].kind: "vehicle"`.
3. Optional state: `objects.<id>.position` + `rotation` for where the car was parked.
