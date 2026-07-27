#!/usr/bin/env bash
# Benchmark matrix for the Inference ray tracer.
#
# Measures wasm-level rendering throughput (samples/s) under the shared Node
# driver. The v1 module (June 2026, Q16.16, 16-slot scene) and the v2 module
# (Q20.20, 506-slot grid) are compared on the identical showcase workload;
# v2 is additionally measured on the book final scene and across threads.
#
# Usage: bash bench/run.sh    (from the project root)
set -eu
cd "$(dirname "$0")/.."

V1=bench/modules/main-v1-2026-06.wasm
V2=out/main.wasm
R="node tools/render.mjs"
OUT=bench/results

echo "== v1 vs v2, showcase scene, single thread (wasm speed progress) =="
$R --wasm $V1 --out /tmp/bench-v1-sc.png --width 320 --height 180 --scene 0 --spp 32 --depth 16 --threads 1 \
   --bench $OUT/v1-showcase-1t.json --label v1-showcase-1t
$R --wasm $V2 --out /tmp/bench-v2-sc.png --width 320 --height 180 --scene 0 --spp 32 --depth 16 --threads 1 \
   --bench $OUT/v2-showcase-1t.json --label v2-showcase-1t

echo "== v2 final scene, single thread =="
$R --wasm $V2 --out /tmp/bench-v2-fin1.png --width 320 --height 180 --scene 1 --spp 32 --depth 16 --threads 1 \
   --bench $OUT/v2-final-1t.json --label v2-final-1t

echo "== v2 final scene, thread scaling =="
for T in 4 8 16; do
  $R --wasm $V2 --out /tmp/bench-v2-fin$T.png --width 320 --height 180 --scene 1 --spp 32 --depth 16 --threads $T \
     --bench $OUT/v2-final-${T}t.json --label v2-final-${T}t
done

echo "== summary =="
node -e '
const fs = require("fs");
const rows = fs.readdirSync("bench/results").filter(f => f.endsWith(".json")).sort().map(f => {
  const j = JSON.parse(fs.readFileSync("bench/results/" + f));
  return { label: j.label, scene: j.settings.scene, threads: j.settings.threads,
           ksps: (j.timing.samples_per_s / 1e3).toFixed(1),
           ns_per_sample: j.timing.ns_per_sample.toFixed(0), wall_s: j.timing.wall_s.toFixed(2) };
});
console.table(rows);
'
