#!/usr/bin/env bash
# Toolchain benchmark snapshot for the Inference ray tracer.
#
# Treats this renderer as a fixed workload for tracking compiler progress:
# builds src/ with the given toolchain, records binary size, build time, an
# image-identity hash (a correctness canary — it changes only when codegen
# semantics change), and best-of-N rendering throughput, then appends one
# JSON line to bench/history.jsonl.
#
# Usage (from anywhere):
#   [REF=<module>] bash bench/snapshot.sh
#
#   INFS / INFC_PATH  toolchain binaries
#                     (default: ~/GitHub/inference/target/release/{infs,infc})
#   TOOLCHAIN_COMMIT  ledger key for this toolchain
#                     (default: `infc --commit-hash`, falling back to the git
#                     HEAD of the repo containing INFC_PATH)
#   MODULE            name this build is preserved under, as
#                     bench/modules/main-$MODULE.wasm (default: the toolchain
#                     commit); set it when a row re-measures a changed source
#                     under a toolchain that already has one
#   REF               a prior row's module name; if set, that preserved module
#                     (bench/modules/main-$REF.wasm) is re-benchmarked
#                     interleaved with the new one, giving this row a
#                     same-conditions baseline
#   REPS              repetitions per workload (default 3; best is recorded)
#   NOTES             free-text note stored in the row
#
# Protocol (see RESULTS.md): settle the machine first — 1-min load < 6, no
# sustained all-core work right before; single-thread numbers off a hot
# machine read 15-30% low. Workloads are interleaved across modules so a
# REF comparison stays fair under drift.
set -eu
cd "$(dirname "$0")/.."

INFS=${INFS:-$HOME/GitHub/inference/target/release/infs}
export INFC_PATH=${INFC_PATH:-$HOME/GitHub/inference/target/release/infc}
COMMIT=${TOOLCHAIN_COMMIT:-$("$INFC_PATH" --commit-hash 2>/dev/null || git -C "$(dirname "$INFC_PATH")" rev-parse --short HEAD)}
export TOOLCHAIN_COMMIT="$COMMIT"
VERSION=$("$INFC_PATH" --version | awk '{print $2}')
MODULE=${MODULE:-$COMMIT}
REF=${REF:-}
REPS=${REPS:-3}
NOTES=${NOTES:-}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -r /proc/loadavg ]; then
  LOAD=$(awk '{print $1}' /proc/loadavg)
else
  LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')
fi
awk -v l="$LOAD" 'BEGIN { if (l >= 6) print "WARNING: 1-min load " l " >= 6 — numbers will read low; settle the machine." }'

# ---- build ------------------------------------------------------------
T0=$(python3 -c 'import time; print(time.time())')
"$INFS" build > "$TMP/build.log" 2>&1 || { cat "$TMP/build.log"; exit 1; }
T1=$(python3 -c 'import time; print(time.time())')
BUILD_S=$(python3 -c "print(round($T1 - $T0, 2))")

# infs prints "wasm-opt -Os: main.wasm <pre> -> <post> bytes" when enabled
if grep -q ' -> .* bytes' "$TMP/build.log"; then
  SIZE_PRE=$(grep ' -> .* bytes' "$TMP/build.log" | tail -1 | grep -o '[0-9]*' | head -1)
  WASM_OPT=$(grep -o 'wasm-opt [^:]*' "$TMP/build.log" | tail -1)
else
  SIZE_PRE=$(wc -c < out/main.wasm | tr -d ' ')
  WASM_OPT=none
fi
SIZE_OPT=$(wc -c < out/main.wasm | tr -d ' ')
WASM_SHA=$(shasum -a 256 out/main.wasm | awk '{print $1}')
SRC_SHA=$(cat src/*.inf | shasum -a 256 | awk '{print $1}')
mkdir -p bench/modules
if [ -e "bench/modules/main-$MODULE.wasm" ] && ! cmp -s out/main.wasm "bench/modules/main-$MODULE.wasm"; then
  echo "bench/modules/main-$MODULE.wasm already holds a different module; set MODULE to a new name." >&2
  exit 1
fi
cp out/main.wasm "bench/modules/main-$MODULE.wasm"

# ---- image-identity canary (deterministic at any thread count) --------
IDENT_SHA=$(bash bench/identity.sh out/main.wasm)

# ---- throughput matrix ------------------------------------------------
MODS=("cur|out/main.wasm")
if [ -n "$REF" ]; then
  MODS=("ref|bench/modules/main-$REF.wasm" "cur|out/main.wasm")
fi
for rep in $(seq 1 "$REPS"); do
  for w in "0 1 sc1t" "1 1 fin1t" "1 16 fin16t"; do
    set -- $w
    for me in "${MODS[@]}"; do
      role=${me%%|*}; wasm=${me#*|}
      node tools/render.mjs --wasm "$wasm" --out "$TMP/b.png" \
        --width 320 --height 180 --scene "$1" --spp 32 --depth 16 --threads "$2" \
        --bench "$TMP/$role-$3-r$rep.json" --label "$role-$3-r$rep" > /dev/null
    done
  done
done

# ---- append the ledger row -------------------------------------------
COMMIT=$COMMIT VERSION=$VERSION MODULE=$MODULE REF=$REF WASM_SHA=$WASM_SHA SRC_SHA=$SRC_SHA IDENT_SHA=$IDENT_SHA \
SIZE_PRE=$SIZE_PRE SIZE_OPT=$SIZE_OPT WASM_OPT=$WASM_OPT BUILD_S=$BUILD_S \
LOAD=$LOAD NOTES=$NOTES TMP=$TMP node -e '
const fs = require("fs"), os = require("os");
const e = process.env;
const runs = { cur: {}, ref: {} };
for (const f of fs.readdirSync(e.TMP).filter(f => f.endsWith(".json") && !f.startsWith("build"))) {
  const m = f.match(/^(cur|ref)-(\w+)-r\d+\.json$/);
  if (!m) continue;
  const j = JSON.parse(fs.readFileSync(e.TMP + "/" + f));
  (runs[m[1]][m[2]] = runs[m[1]][m[2]] || []).push(+(j.timing.samples_per_s / 1e3).toFixed(1));
}
// A ref names a preserved module; its toolchain is the row that recorded it
// (rows before the `module` field was added are named by their commit).
const refCommit = m => {
  const rows = fs.readFileSync("bench/history.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const hit = rows.reverse().find(r => (r.module || r.toolchain_commit) === m);
  return hit ? hit.toolchain_commit : m;
};
const best = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.max(...v)]));
const row = {
  date: new Date().toISOString().slice(0, 10),
  toolchain_commit: e.COMMIT, toolchain_version: e.VERSION,
  toolchain_profile: "release", module: e.MODULE,
  source_sha256: e.SRC_SHA, wasm_sha256: e.WASM_SHA,
  size_preopt: +e.SIZE_PRE, size_opt: +e.SIZE_OPT, wasm_opt: e.WASM_OPT,
  build_wall_s: +e.BUILD_S,
  identity_sha256: e.IDENT_SHA,
  bench_ksps: best(runs.cur), runs_ksps: runs.cur,
  ref: e.REF ? { module: e.REF, commit: refCommit(e.REF), bench_ksps: best(runs.ref), runs_ksps: runs.ref } : null,
  host: String((os.cpus()[0] || {}).model || "unknown CPU").trim() + ", " + os.cpus().length + " cores",
  node: process.version, load_1m: +e.LOAD,
  notes: e.NOTES,
};
fs.appendFileSync("bench/history.jsonl", JSON.stringify(row) + "\n");
console.log("appended to bench/history.jsonl:");
console.log(JSON.stringify(row, null, 2));
'
