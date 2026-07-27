# Benchmark results — 2026-07-22

Host: Apple M5 Pro (6P + 12E, 18 cores), Node v26, macOS (Darwin 25.5.0).
Toolchain: inference @ be1d239 (release), wasm-opt Binaryen 130 via
`[build.wasm-opt] level = "s"`. Shipped wasm: 9,492 bytes (15,424 pre-opt),
sha256 b1d439687e03621f… (full hash in the JSONs).
Driver: `tools/render.mjs` — the same driver runs both modules; sampling is
seeded in-wasm from (px, py, sample), so images are byte-identical at any
thread count (verified).

Protocol: single-thread numbers taken on a settled machine (1-min load < 6),
interleaved/repeated runs agreeing within ~2%. Sustained all-core rendering
immediately beforehand depresses a follow-up single-thread run by ~15-30% —
never benchmark hot.

## Renderer progress: v1 (June 2026) vs v2 — identical workload

Showcase scene, 320×180, 32 spp, depth 16, **1 thread**:

| module | ksamples/s | ns/sample | speedup |
|---|---|---|---|
| v1 `main.wasm` (Q16.16, xorshift, linked fixmath kernel, 16-slot scene) | 315.7 | 3168 | 1.0× |
| v2 `main.wasm` (Q20.20, splitmix64, native `/`, 506-slot grid) | **644.1** | **1553** | **2.04×** |

v2 renders the same six spheres at twice the throughput while doing strictly
more per-bounce work — its nearest-hit scan walks a 506-slot grid (v1: 16
slots) — and at 16× finer fixed-point resolution with a sounder RNG. The
wins: native `i64` division (v1's linked kernel spent 5–7 divisions inside
each `fixsqrt` alone), no per-bounce scene-array copies, unit-direction rays
(no `recip(lensq(dir))` per sphere test), and no external-linkage overhead.

## The book final scene (v1 could not represent this scene at all)

320×180, 32 spp, depth 16 — ~400 live spheres, defocus blur:

| threads | ksamples/s | ns/sample | scaling |
|---|---|---|---|
| 1 | 276.2 | 3621 | 1.0× |
| 4 | 1055.8 | 947 | 3.8× |
| 8 | 1795.6 | 557 | 6.5× |
| 16 | **2938.3** | **340** | 10.6× |

A full-scene sample (≈490 sphere tests × ~5 bounce segments) costs just
3.6 µs single-threaded — ~1.5 ns per inlined fixed-point sphere test.

## Optimizer-level note (measured, so nobody re-litigates it)

Binaryen level vs single-thread throughput on this module under Node/V8:

| workload | raw | -O2 | -O3 | -O4 | -Os |
|---|---|---|---|---|---|
| showcase | 727 | 624 | 577 | 632 | 634 |
| final scene | 256 | 275 | 259 | 261 | **275** |

`-Os` wins the workload that matters (the final scene) and the size contest;
`-O3` is the *worst* choice here. Small-workload (showcase) numbers swing
±25% across semantically identical builds as inlining decisions shift — treat
showcase deltas under ~30% as JIT fortune, and trust the final-scene column.

## Reference points

- The shipped max-quality artifact `out/final-hq-2400.png` (2400×1350,
  2000 spp, depth 50 = 6.48 G samples) rendered in 67 min at 17 threads —
  1.61 Msamples/s sustained over the full hour (thermal steady-state; the
  32-spp benchmark peak is 2.94 Msamples/s). Run recorded in
  `bench/results/v2-final-hq-2400x1350-2000spp-17t.json`; `out/final-hq.png`
  is its 2×2 linear-light downscale (effective 8000 spp at 1200×675).
- Book-cover-quality (1200×675, 500 spp, depth 50): ~4 min at 16 threads.
- Raw JSON for every run (wasm SHA-256, host, toolchain commit, timings):
  `bench/results/*.json`. Reproduce: `bash bench/run.sh`.

# 2026-07-27 — toolchain be1d239 → 4f6738a

Same source (modulo one comment), rebuilt across two toolchain snapshots.
Ledger row + protocol: `bench/history.jsonl`, appended via `bench/snapshot.sh`
(which also re-benchmarks a preserved reference module interleaved, so every
row carries a same-conditions baseline). Preserved modules live in
`bench/modules/`. What changed in the compiler between the two commits is at
[`Inferara/inference@be1d239...4f6738a`](https://github.com/Inferara/inference/compare/be1d239...4f6738a).

## The image changed between the two toolchains

The image-identity hash moved between these snapshots. At spp=1 the two modules
render **byte-identical** images; at spp≥2 they diverge, and the gap widens with
sample count and depth. Measured:

| workload | pixels differing | max channel Δ |
|---|---|---|
| 320×180, spp 8, depth 16, showcase | 2.36% | — |
| 320×180, spp 8, depth 16, final | 17.05% | 150 |
| 2400×1350, spp 2000, depth 50, final | 34.1% (mean Δ14.2, RMS 25.4) | 146 |

The divergence is **strictly one-sided**: across all 9.72 M channel values of
the HQ frame, none are brighter under `4f6738a`. The `be1d239` renders are
preserved for comparison (`out/*-be1d239.png`).

## HQ artifact re-render (2026-07-27)

`out/final-hq-2400.png` + `out/final-hq.png` re-rendered under `4f6738a`, same
settings (2400×1350, 2000 spp, depth 50, 17 threads): 4,079.75 s wall,
1,588.3 ksamples/s sustained (be1d239 run: 4,017.8 s / 1,610 ks/s — parity
within 1.5% at thermal steady state). Originals kept as
`out/final-hq-2400-be1d239.png` / `out/final-hq-be1d239.png`; run records in
`bench/results/v2-final-hq-2400x1350-2000spp-17t{,-4f6738a}.json`.

## Size and speed

|  | be1d239 | 4f6738a | delta |
|---|---|---|---|
| wasm pre-opt | 15,424 B | 15,496 B | +72 B |
| wasm shipped (-Os) | 9,492 B | 9,541 B | +49 B (+0.5%) |
| showcase 1t | 639.1 | 640.0 ksps | noise |
| final scene 1t | 272.3 | 275.6 ksps | noise |
| final scene 16t | 2957.2 | 2955.3 ksps | noise |

(Speed = best-of-3, interleaved, load < 6; both modules measured 2026-07-27.
Build wall time under `4f6738a`: 0.08 s, compile + wasm-opt.)
