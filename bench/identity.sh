#!/usr/bin/env bash
# Image-identity canary: renders a small deterministic image and prints
#
#   <rgb-sha256> <png-sha256>
#
# The render is seeded in-wasm from (px, py, sample), so its pixels depend
# only on what the module computes, never on the thread count or the host.
# They move only when codegen semantics do.
#
#   rgb-sha256  hash of the decoded image data (the PNG's inflated scanlines):
#               the same on every host, so CI compares it with the ledger
#   png-sha256  hash of the PNG file, which also depends on the deflate
#               implementation of the Node that wrote it; ledger rows before
#               identity_rgb_sha256 existed recorded only this one
#
# bench/snapshot.sh records both in every ledger row, so the settings below are
# defined here once.
#
# Usage: bash bench/identity.sh <module.wasm>
set -eu
cd "$(dirname "$0")/.."

WASM=${1:?usage: bash bench/identity.sh <module.wasm>}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node tools/render.mjs --wasm "$WASM" --out "$TMP/ident.png" \
  --width 320 --height 180 --scene 1 --spp 8 --depth 16 --threads 4 > /dev/null
node -e '
const fs = require("fs"), zlib = require("zlib"), crypto = require("crypto");
const png = fs.readFileSync(process.argv[1]);
const idat = [];
for (let off = 8; off < png.length; ) {
  const len = png.readUInt32BE(off);
  if (png.toString("latin1", off + 4, off + 8) === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
  off += 12 + len;
}
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
console.log(sha(zlib.inflateSync(Buffer.concat(idat))) + " " + sha(png));
' "$TMP/ident.png"
