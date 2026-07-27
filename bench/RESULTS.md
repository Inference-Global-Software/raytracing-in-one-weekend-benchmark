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

# 2026-07-27 — toolchain 4f6738a (post codegen-audit, Inferara/inference PRs #301–#311)

Same source (modulo one comment), rebuilt with the toolchain that carries the
eleven codegen-audit fixes. Ledger row + protocol: `bench/history.jsonl`,
appended via `bench/snapshot.sh` (which also re-benchmarks a preserved
reference module interleaved, so every row carries a same-conditions
baseline). Preserved modules live in `bench/modules/`.

## Image correctness: every pre-#302 render was subtly wrong

The old module carried a real image defect inherited from a compiler bug
([Inferara/inference#302](https://github.com/Inferara/inference/pull/302), loop-scoped compound literals not re-zeroed): the per-sample
radiance accumulator `col` in `render_pixel` was initialized `{0,0,0}` only on
the first sample; samples 2+ started from the previous sample's final color,
which leaked stale brightness into any ray that exhausted its bounce budget.

Proof of mechanism: at spp=1 the two modules render **byte-identical** images
(first iteration sees the zeroed frame); at spp≥2 they diverge. At the
benchmark settings (320×180, spp 8, depth 16) the defect touched 17.05% of
final-scene pixels (max channel delta 150) and 2.36% of showcase pixels.
The image-identity hash in each ledger row is the regression canary for
exactly this class of bug.

## HQ artifact re-render (2026-07-27)

`out/final-hq-2400.png` + `out/final-hq.png` re-rendered with the corrected
module, same settings (2400×1350, 2000 spp, depth 50, 17 threads): 4,079.75 s
wall, 1,588.3 ksamples/s sustained (be1d239 run: 4,017.8 s / 1,610 ks/s —
parity within 1.5% at thermal steady state). The be1d239 originals are kept as
`out/final-hq-2400-be1d239.png` / `out/final-hq-be1d239.png`; run records in
`bench/results/v2-final-hq-2400x1350-2000spp-17t{,-4f6738a}.json`.

The defect was NOT marginal at depth 50 (an earlier note here guessed it
would be): **34.1% of pixels differ** (mean channel delta 14.2, RMS 25.4,
max 146 on differing pixels). The divergence is **strictly one-sided** —
across all 9.72 M channel values, zero are brighter in the corrected render —
i.e. the old image contained only *added* phantom light, concentrated where
paths exhaust the 50-bounce budget: sphere/ground contact traps smeared into
every out-of-focus bokeh blob by defocus blur, and grazing/TIR rims on the
two hero spheres. The old render's extra "glow" was leak, not light
transport; the corrected render's darker bokeh and contact shadows are the
true values.

## Size and speed

|  | be1d239 | 4f6738a | delta |
|---|---|---|---|
| wasm pre-opt | 15,424 B | 15,496 B | +72 B |
| wasm shipped (-Os) | 9,492 B | 9,541 B | +49 B (+0.5%) |
| showcase 1t | 639.1 | 640.0 ksps | noise |
| final scene 1t | 272.3 | 275.6 ksps | noise |
| final scene 16t | 2957.2 | 2955.3 ksps | noise |

(Speed = best-of-3, interleaved, load < 6; both modules measured 2026-07-27.)

The +49 B decomposes into the #302 zero stores (scene/sample loops — the
correctness fix above) and one short-circuit valued-if (Inferara/inference#309)
in the dielectric
`||`. The hot-path `&&` sites in the sphere-hit scan also lower short-circuit
now, but Binaryen -Os folds pure-compare valued-ifs back to branchless
`i32.and` — the shipped hot loop is byte-equivalent, which is why throughput
is flat. Build wall time: 0.08 s (compile + wasm-opt).
