#!/usr/bin/env bash
# Image-identity canary: prints the SHA-256 of a small deterministic render.
#
# The render is seeded in-wasm from (px, py, sample), so the hash depends only
# on what the module computes, never on the thread count or the host. It moves
# only when codegen semantics do. bench/snapshot.sh records it in every ledger
# row and CI compares a fresh build against the latest row, so the settings
# below are defined here once for both.
#
# Usage: bash bench/identity.sh <module.wasm>
set -eu
cd "$(dirname "$0")/.."

WASM=${1:?usage: bash bench/identity.sh <module.wasm>}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node tools/render.mjs --wasm "$WASM" --out "$TMP/ident.png" \
  --width 320 --height 180 --scene 1 --spp 8 --depth 16 --threads 4 > /dev/null
shasum -a 256 "$TMP/ident.png" | awk '{print $1}'
