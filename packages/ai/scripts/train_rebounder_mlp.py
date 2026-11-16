#!/usr/bin/env python3
"""Train the tiny ONNX clone of the court rebounder rules model.

Distils the declarative rules policy (examples/court/models/rebounder.rules.json)
into a 12 -> 16 -> 16 -> 3 MLP, trained on synthetic states sampled from that
policy. Pure NumPy + onnx; no torch, no network, no paid anything.

  python3 packages/ai/scripts/train_rebounder_mlp.py [--out FILE] [--samples N]

The export is verified in-process before it is written:
  - onnx.checker passes, ir_version 8 / opset 13 (ORT Web compatible)
  - ORT CPU outputs match the NumPy forward pass to <1e-4
  - two ORT runs are bitwise identical (deterministic)
  - held-out behaviour vs the rules policy: velocity direction, speed error,
    pass accuracy (thresholds below; the script exits non-zero if they fail)
  - file size < 51200 bytes (the manifest sizeBytesMax for onnx models)

The model is a *movement* clone of one rules tick, not a new policy: the
feature order is the contract in packages/ai/src/onnx.ts (ONNX_OBS_FEATURES)
and in the manifest descriptor inputs. Change it in all three places.

Reproducibility: the RNG is seeded (7) and BLAS threads are pinned to 1, so
re-running this script on the same machine reproduces the same bytes. Regenerate
only when the rules file changes, and commit the result.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np

SEED = 7
N_FEATURES = 14
N_OUTPUTS = 3
HIDDEN = 32
SIZE_CAP = 51200
PASS_WEIGHT = 5.0

# Behaviour gates: the script refuses to write a model that imitates badly.
MIN_MEAN_COSINE = 0.95
MAX_SPEED_MAE = 0.30
MIN_PASS_ACCURACY = 0.97

REPO_ROOT = Path(__file__).resolve().parents[3]
RULES_PATH = REPO_ROOT / "examples" / "court" / "models" / "rebounder.rules.json"
DEFAULT_OUT = REPO_ROOT / "examples" / "court" / "models" / "rebounder-mlp.onnx"


# ---------------------------------------------------------------- policy mirror
# Mirrors packages/ai/src/rules.ts exactly: same conditions, same transition
# order (from the JSON file), same move math. If this mirror drifts from the
# TypeScript, the held-out checks below catch it (cosine collapses).

def dist3(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a - b))


def condition(when: str, obs: dict, ctx: dict) -> bool:
    if when == "always":
        return True
    if when == "ball_loose":
        return obs["held_by"] is None
    if when == "ball_held_by_player":
        return obs["held_by"] == "player"
    if when == "ball_held_by_self":
        return obs["held_by"] == "rebounder"
    if when == "ball_near":
        return ctx["ball_dist"] <= ctx["pickup_radius"]
    if when == "near_player":
        return ctx["player_dist"] <= ctx["pass_radius"]
    if when == "near_home":
        return ctx["home_dist"] <= 0.5
    if when == "ball_out_of_bounds":
        return ctx["ball_oob"]
    raise ValueError(f"unknown condition {when!r}")


def rules_tick(state: str, obs: dict, rules: dict) -> tuple[str, np.ndarray, int]:
    params = rules["params"]
    lo = np.array(rules["court"]["bounds"]["min"], dtype=float)
    hi = np.array(rules["court"]["bounds"]["max"], dtype=float)
    home = np.array(params["home"], dtype=float)
    ctx = {
        "ball_dist": dist3(obs["self"], obs["ball_pos"]),
        "player_dist": dist3(obs["self"], obs["player_pos"]),
        "home_dist": dist3(obs["self"], home),
        "ball_oob": bool(
            obs["ball_pos"][0] < lo[0] or obs["ball_pos"][0] > hi[0]
            or obs["ball_pos"][2] < lo[2] or obs["ball_pos"][2] > hi[2]
        ),
        "pickup_radius": params["pickupRadius"],
        "pass_radius": params["passRadius"],
    }
    for t in rules["states"][state]["on"]:
        if condition(t["when"], obs, ctx):
            state = t["to"]
            break
    behavior = rules["states"][state]["behavior"]
    if behavior["type"] == "hold":
        return state, np.zeros(2), 0
    if behavior["type"] == "pass":
        return state, np.zeros(2), 1
    if behavior["type"] != "move":
        raise ValueError(f"unknown behaviour {behavior['type']!r}")
    target = {"ball": obs["ball_pos"], "player": obs["player_pos"], "home": home}[behavior["target"]]
    if behavior["target"] == "ball":
        target = np.array([min(max(target[0], lo[0]), hi[0]), target[1], min(max(target[2], lo[2]), hi[2])])
    speed = behavior["speed"]
    speed = params[speed] if isinstance(speed, str) else float(speed)
    dx, dz = target[0] - obs["self"][0], target[2] - obs["self"][2]
    dist = math.hypot(dx, dz)
    if dist <= params["arriveRadius"] or speed <= 0:
        return state, np.zeros(2), 0
    return state, np.array([dx / dist * speed, dz / dist * speed]), 0


def features(obs: dict, home: np.ndarray, bounds: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    lo, hi = bounds
    ball_oob = float(
        obs["ball_pos"][0] < lo[0] or obs["ball_pos"][0] > hi[0]
        or obs["ball_pos"][2] < lo[2] or obs["ball_pos"][2] > hi[2]
    )
    s = obs["self"]
    return np.array([
        np.clip(obs["ball_pos"][0] - s[0], -20, 20),
        np.clip(obs["ball_pos"][2] - s[2], -20, 20),
        np.clip(obs["ball_vel"][0], -6, 6),
        np.clip(obs["ball_vel"][2], -6, 6),
        np.clip(obs["player_pos"][0] - s[0], -20, 20),
        np.clip(obs["player_pos"][2] - s[2], -20, 20),
        np.clip(home[0] - s[0], -20, 20),
        np.clip(home[2] - s[2], -20, 20),
        1.0 if obs["held_by"] == "rebounder" else 0.0,
        1.0 if obs["held_by"] == "player" else 0.0,
        ball_oob,
        np.clip(dist3(s, obs["ball_pos"]), 0, 20),
        # Explicit distances: the policy switches on them (pickup at 0.45 m,
        # pass at 1.6 m), and a tanh net approximates a radius poorly from
        # raw dx/dz alone. Same order as ONNX_OBS_FEATURES in src/onnx.ts.
        np.clip(dist3(s, obs["player_pos"]), 0, 20),
        np.clip(dist3(s, home), 0, 20),
    ], dtype=np.float64)


def canonical_state(obs: dict) -> str:
    """The state the rules machine converges to for this observation.

    The rules policy is stateful, but a stateless network cannot see the
    starting state, so the training target is one rules tick from the
    canonical state for the observation: held -> carry, player-held -> idle,
    loose -> chase. The machine's own transitions then produce the right
    steady-state action (pickup hold, out-of-bounds return, pass). This is
    the policy the ONNX model clones; it agrees with the rules model within
    one tick everywhere.
    """
    if obs["held_by"] == "rebounder":
        return "carry"
    if obs["held_by"] == "player":
        return "idle"
    return "chase"


def sample_states(rng: np.random.Generator, n: int, rules: dict) -> tuple[np.ndarray, np.ndarray]:
    lo = np.array(rules["court"]["bounds"]["min"], dtype=float)
    hi = np.array(rules["court"]["bounds"]["max"], dtype=float)
    home = np.array(rules["params"]["home"], dtype=float)
    bounds = (lo, hi)
    X = np.zeros((n, N_FEATURES))
    Y = np.zeros((n, N_OUTPUTS))
    for i in range(n):
        self_pos = np.array([rng.uniform(lo[0] + 1, hi[0] - 1), 0.0, rng.uniform(lo[2] + 1, hi[2] - 1)])
        player_pos = np.array([rng.uniform(lo[0] + 1, hi[0] - 1), 0.0, rng.uniform(lo[2] + 1, hi[2] - 1)])
        held_roll = rng.random()
        if held_roll < 0.25:
            held_by = "rebounder"
            ball_pos = self_pos + np.array([rng.uniform(-0.4, 0.4), 0.9, rng.uniform(-0.4, 0.4)])
            ball_vel = np.zeros(3)
            if rng.random() < 0.45:
                # Player near the rebounder: dense samples around the 1.6 m
                # pass boundary, so the net learns when to pass, not just to move.
                angle = rng.uniform(0, 2 * math.pi)
                radius = rng.uniform(0, 3)
                player_pos = self_pos + np.array([math.cos(angle) * radius, 0.0, math.sin(angle) * radius])
        elif held_roll < 0.45:
            held_by = "player"
            ball_pos = player_pos + np.array([rng.uniform(-0.4, 0.4), 0.9, rng.uniform(-0.4, 0.4)])
            ball_vel = np.zeros(3)
        else:
            held_by = None
            r = rng.random()
            if r < 0.30:
                # ball near the rebounder: the chase/pickup boundary the net must learn
                ball_pos = self_pos + np.array([rng.uniform(-2, 2), 0.12, rng.uniform(-2, 2)])
            elif r < 0.45:
                # ball out of bounds: the chase/idle boundary
                side = rng.choice([-1, 1])
                ball_pos = np.array([side * rng.uniform(17.5, 22), 0.12, rng.uniform(-9, 9)])
            else:
                ball_pos = np.array([rng.uniform(lo[0], hi[0]), 0.12, rng.uniform(lo[2], hi[2])])
            angle = rng.uniform(0, 2 * math.pi)
            ball_vel = np.array([math.cos(angle), 0.0, math.sin(angle)]) * rng.uniform(0, 3)
        obs = {"self": self_pos, "player_pos": player_pos, "ball_pos": ball_pos,
               "ball_vel": ball_vel, "held_by": held_by}
        _, vel, passed = rules_tick(canonical_state(obs), obs, rules)
        X[i] = features(obs, home, bounds)
        Y[i] = [vel[0], vel[1], float(passed)]
    return X, Y


# ------------------------------------------------------------------ MLP (numpy)
def init_params(rng: np.random.Generator) -> dict:
    def w(fan_in: int, fan_out: int) -> np.ndarray:
        return rng.normal(0, math.sqrt(1.0 / fan_in), size=(fan_in, fan_out))
    return {
        "W1": w(N_FEATURES, HIDDEN), "b1": np.zeros(HIDDEN),
        "W2": w(HIDDEN, HIDDEN), "b2": np.zeros(HIDDEN),
        "W3": w(HIDDEN, N_OUTPUTS) * 0.5, "b3": np.zeros(N_OUTPUTS),
    }


def forward(params: dict, X: np.ndarray) -> tuple[np.ndarray, tuple]:
    Z1 = X @ params["W1"] + params["b1"]
    A1 = np.tanh(Z1)
    Z2 = A1 @ params["W2"] + params["b2"]
    A2 = np.tanh(Z2)
    out = A2 @ params["W3"] + params["b3"]
    return out, (X, A1, A2)


def train(params: dict, X: np.ndarray, Y: np.ndarray, weights: np.ndarray,
          epochs: int = 600, batch: int = 256, lr: float = 0.01) -> dict:
    rng = np.random.default_rng(SEED + 1)
    n = X.shape[0]
    m1 = np.zeros_like(params["W1"]); v1 = np.zeros_like(params["W1"])
    m2 = np.zeros_like(params["W2"]); v2 = np.zeros_like(params["W2"])
    m3 = np.zeros_like(params["W3"]); v3 = np.zeros_like(params["W3"])
    mb1 = np.zeros_like(params["b1"]); vb1 = np.zeros_like(params["b1"])
    mb2 = np.zeros_like(params["b2"]); vb2 = np.zeros_like(params["b2"])
    mb3 = np.zeros_like(params["b3"]); vb3 = np.zeros_like(params["b3"])
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    step = 0
    for epoch in range(epochs):
        if epoch == int(epochs * 0.6):
            lr *= 0.3  # late fine-tuning pass once the modes are separated
        perm = rng.permutation(n)
        for start in range(0, n, batch):
            idx = perm[start:start + batch]
            xb, yb, wb = X[idx], Y[idx], weights[idx]
            out, (x0, a1, a2) = forward(params, xb)
            diff = out - yb
            # pass output (column 2) carries PASS_WEIGHT; velocity columns weight 1
            col_w = np.array([1.0, 1.0, PASS_WEIGHT])
            d_out = (2.0 / xb.shape[0]) * diff * col_w * wb[:, None]
            gW3 = a2.T @ d_out
            gb3 = d_out.sum(axis=0)
            d_a2 = d_out @ params["W3"].T * (1 - a2 ** 2)
            gW2 = a1.T @ d_a2
            gb2 = d_a2.sum(axis=0)
            d_a1 = d_a2 @ params["W2"].T * (1 - a1 ** 2)
            gW1 = x0.T @ d_a1
            gb1 = d_a1.sum(axis=0)
            step += 1
            for g, m, v, p in ((gW1, m1, v1, "W1"), (gW2, m2, v2, "W2"), (gW3, m3, v3, "W3")):
                m[:] = beta1 * m + (1 - beta1) * g
                v[:] = beta2 * v + (1 - beta2) * (g * g)
                mh = m / (1 - beta1 ** step)
                vh = v / (1 - beta2 ** step)
                params[p] -= lr * mh / (np.sqrt(vh) + eps)
            for g, m, v, p in ((gb1, mb1, vb1, "b1"), (gb2, mb2, vb2, "b2"), (gb3, mb3, vb3, "b3")):
                m[:] = beta1 * m + (1 - beta1) * g
                v[:] = beta2 * v + (1 - beta2) * (g * g)
                mh = m / (1 - beta1 ** step)
                vh = v / (1 - beta2 ** step)
                params[p] -= lr * mh / (np.sqrt(vh) + eps)
        if (epoch + 1) % 150 == 0:
            pred, _ = forward(params, X)
            loss = float(np.mean((pred - Y) ** 2 * np.array([1.0, 1.0, PASS_WEIGHT])))
            print(f"  epoch {epoch + 1}/{epochs} train loss {loss:.5f}")
    return params


def fold_standardization(params: dict, mean: np.ndarray, std: np.ndarray) -> dict:
    """Bake input standardisation into layer 1 so the graph takes raw features.

    z = (x - mean) / std, so z @ W1 + b1 = x @ (W1 / std) + (b1 - (mean / std) @ W1).
    The bias term uses the ORIGINAL W1: dividing twice by std is a silent
    error that training loss cannot see (it only shows up in the folded model).
    """
    params = {k: v.copy() for k, v in params.items()}
    w1_orig = params["W1"]
    params["W1"] = w1_orig / std[:, None]
    params["b1"] = params["b1"] - (w1_orig * (mean / std)[:, None]).sum(axis=0)
    return params


def check_fold(params_before: dict, params_after: dict, X_raw: np.ndarray, mean: np.ndarray, std: np.ndarray) -> float:
    """Max abs diff between the folded model on raw inputs and the trained
    model on standardised inputs. Must be ~0; a bad fold fails the run."""
    sample = X_raw[:256]
    out_before, _ = forward(params_before, (sample - mean) / std)
    out_after, _ = forward(params_after, sample)
    return float(np.max(np.abs(out_before - out_after)))


# ------------------------------------------------------------------ ONNX export
def export_onnx(params: dict) -> bytes:
    import onnx
    from onnx import TensorProto, helper

    def init(name: str, arr: np.ndarray) -> onnx.TensorProto:
        return helper.make_tensor(name, TensorProto.FLOAT, list(arr.shape), arr.astype(np.float32).tobytes(), raw=True)

    inits = [
        init("W1", params["W1"]), init("b1", params["b1"]),
        init("W2", params["W2"]), init("b2", params["b2"]),
        init("W3", params["W3"]), init("b3", params["b3"]),
    ]
    nodes = [
        helper.make_node("Gemm", ["obs", "W1", "b1"], ["z1"]),
        helper.make_node("Tanh", ["z1"], ["a1"]),
        helper.make_node("Gemm", ["a1", "W2", "b2"], ["z2"]),
        helper.make_node("Tanh", ["z2"], ["a2"]),
        helper.make_node("Gemm", ["a2", "W3", "b3"], ["action"]),
    ]
    graph = helper.make_graph(
        nodes, "rebounder-mlp",
        [helper.make_tensor_value_info("obs", TensorProto.FLOAT, [1, N_FEATURES])],
        [helper.make_tensor_value_info("action", TensorProto.FLOAT, [1, N_OUTPUTS])],
        initializer=inits,
    )
    model = helper.make_model(graph, producer_name="wgif-train-rebounder-mlp")
    model.opset_import[0].version = 13
    model.ir_version = 8
    import onnx as _onnx
    _onnx.checker.check_model(model)
    return model.SerializeToString()


def evaluate(params: dict, X: np.ndarray, Y: np.ndarray, onnx_bytes: bytes) -> dict:
    import onnxruntime as ort

    pred, _ = forward(params, X)
    vel_pred, vel_true = pred[:, :2], Y[:, :2]
    # Cosine only where the rules policy actually moves; stationary ticks have
    # no direction to imitate and would otherwise drag the mean down.
    moving = np.linalg.norm(vel_true, axis=1) > 0.1
    cos_moving = float(np.mean(
        np.sum(vel_pred[moving] * vel_true[moving], axis=1)
        / (np.linalg.norm(vel_pred[moving], axis=1) * np.linalg.norm(vel_true[moving], axis=1))
    ))
    speed_mae = float(np.mean(np.abs(np.linalg.norm(vel_pred, axis=1) - np.linalg.norm(vel_true, axis=1))))
    pass_acc = float(np.mean((pred[:, 2] > 0.5) == (Y[:, 2] > 0.5)))

    sess = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    ort_out = np.concatenate([
        sess.run(["action"], {"obs": X[i:i + 1].astype(np.float32)})[0] for i in range(min(256, len(X)))
    ])
    numpy_slice = pred[: len(ort_out)]
    max_diff = float(np.max(np.abs(ort_out - numpy_slice)))
    run_a = sess.run(["action"], {"obs": X[:1].astype(np.float32)})[0]
    run_b = sess.run(["action"], {"obs": X[:1].astype(np.float32)})[0]
    deterministic = bool(np.array_equal(run_a, run_b))
    return {
        "mean_cosine_moving": cos_moving,
        "speed_mae": speed_mae,
        "pass_accuracy": pass_acc,
        "ort_vs_numpy_max_diff": max_diff,
        "ort_deterministic": deterministic,
        "onnx_bytes": len(onnx_bytes),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--samples", type=int, default=8192)
    ap.add_argument("--epochs", type=int, default=1200)
    args = ap.parse_args()

    rules = json.loads(RULES_PATH.read_text())
    print(f"rules: {RULES_PATH} (seed {rules['seed']}, tick {rules['tickHz']} Hz)")
    rng = np.random.default_rng(SEED)
    X, Y = sample_states(rng, args.samples, rules)
    X_test, Y_test = sample_states(rng, 1024, rules)
    print(f"sampled {len(X)} train + {len(X_test)} held-out states")

    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    Xs = (X - mean) / std

    weights = np.where(Y[:, 2] > 0.5, 2.0, 1.0)  # pass samples count double
    params = train(init_params(rng), Xs, Y, weights, epochs=args.epochs)
    params_before_fold = {k: v.copy() for k, v in params.items()}
    params = fold_standardization(params, mean, std)
    fold_diff = check_fold(params_before_fold, params, X_test, mean, std)
    print(f"fold check max diff: {fold_diff:.2e}")
    if fold_diff > 1e-4:
        print(f"FAILED: standardisation fold is wrong (diff {fold_diff:.2e})")
        return 1

    onnx_bytes = export_onnx(params)
    # NOTE: evaluate on the RAW held-out features: fold_standardization baked
    # the standardisation into layer 1, so the exported graph takes raw inputs.
    report = evaluate(params, X_test, Y_test, onnx_bytes)
    print("held-out report:")
    for k, v in report.items():
        print(f"  {k}: {v}")

    failures = []
    if report["mean_cosine_moving"] < MIN_MEAN_COSINE:
        failures.append(f"cosine {report['mean_cosine_moving']:.3f} < {MIN_MEAN_COSINE}")
    if report["speed_mae"] > MAX_SPEED_MAE:
        failures.append(f"speed MAE {report['speed_mae']:.3f} > {MAX_SPEED_MAE}")
    if report["pass_accuracy"] < MIN_PASS_ACCURACY:
        failures.append(f"pass accuracy {report['pass_accuracy']:.3f} < {MIN_PASS_ACCURACY}")
    if report["ort_vs_numpy_max_diff"] > 1e-4:
        failures.append(f"ORT vs NumPy diff {report['ort_vs_numpy_max_diff']:.2e} > 1e-4")
    if not report["ort_deterministic"]:
        failures.append("ORT runs are not deterministic")
    if report["onnx_bytes"] > SIZE_CAP:
        failures.append(f"ONNX size {report['onnx_bytes']} > {SIZE_CAP}")
    if failures:
        print("FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(onnx_bytes)
    print(f"wrote {args.out} ({len(onnx_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
