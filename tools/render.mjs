#!/usr/bin/env node
// Parallel offline renderer + benchmark harness for the Inference ray tracer.
//
// The wasm module owns every rendering decision; this driver only:
//   * calls render_pixel(px, py, w, h, spp, depth, scene) -> packed 0x00RRGGBB
//   * spreads rows across worker threads (deterministic output: all sampling
//     is seeded in-wasm from pixel coordinates, so thread count never changes
//     the image)
//   * assembles the PNG and writes benchmark JSON
//
// Usage:
//   node tools/render.mjs --wasm out/main.wasm --out out/final.png \
//        --width 1200 --height 675 --scene 1 --spp 500 --depth 50 \
//        [--threads N] [--bench bench/results/run.json] [--label final-500spp] \
//        [--checkpoint out/preview.png] [--checkpoint-secs 30]
//
// Works against both the v2 module and the June-2026 v1 module (same ABI).

import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { cpus, arch, platform } from 'node:os';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------- worker

if (!isMainThread) {
  const { wasmBytes, width, height, spp, depth, scene, pixels, nextRow, done } = workerData;
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const render_pixel = instance.exports.render_pixel;
  const W = BigInt(width), H = BigInt(height);
  const S = BigInt(spp), D = BigInt(depth), SC = BigInt(scene);
  const px = new Uint8Array(pixels);
  const ctr = new Int32Array(nextRow);
  const doneRows = new Int32Array(done);
  for (;;) {
    const y = Atomics.add(ctr, 0, 1);
    if (y >= height) break;
    const Y = BigInt(y);
    let off = y * width * 3;
    for (let x = 0; x < width; x++) {
      const packed = Number(render_pixel(BigInt(x), Y, W, H, S, D, SC));
      px[off++] = (packed >> 16) & 0xff;
      px[off++] = (packed >> 8) & 0xff;
      px[off++] = packed & 0xff;
    }
    Atomics.add(doneRows, 0, 1);
  }
  parentPort.postMessage('done');
  process.exit(0);
}

// ------------------------------------------------------------------- main

function parseArgs(argv) {
  const a = {
    wasm: 'out/main.wasm', out: 'out/render.png',
    width: 400, height: 225, scene: 1, spp: 32, depth: 16,
    threads: Math.max(1, cpus().length - 1),
    bench: null, label: null, checkpoint: null, checkpointSecs: 30,
  };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k === 'checkpoint-secs') a.checkpointSecs = Number(v);
    else if (['width', 'height', 'scene', 'spp', 'depth', 'threads'].includes(k)) a[k] = Number(v);
    else if (k in a) a[k] = v;
    else { console.error(`unknown arg --${k}`); process.exit(1); }
  }
  return a;
}

// Minimal PNG encoder: 8-bit RGB, filter 0, one IDAT.
function encodePNG(width, height, rgb) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    rgb.copy ? rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3)
             : Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (1 + width * 3) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const args = parseArgs(process.argv);
const wasmPath = resolve(args.wasm);
const wasmBytes = readFileSync(wasmPath);
const { width, height, spp, depth, scene, threads } = args;

const pixels = new SharedArrayBuffer(width * height * 3);
const nextRow = new SharedArrayBuffer(4);
const done = new SharedArrayBuffer(4);
const doneRows = new Int32Array(done);

console.log(`render ${width}x${height} scene=${scene} spp=${spp} depth=${depth} threads=${threads}`);
console.log(`wasm: ${wasmPath} (${wasmBytes.length} bytes)`);

const t0 = process.hrtime.bigint();
const workers = [];
for (let i = 0; i < threads; i++) {
  workers.push(new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), {
      workerData: { wasmBytes, width, height, spp, depth, scene, pixels, nextRow, done },
    });
    w.on('message', res);
    w.on('error', rej);
    w.on('exit', (c) => (c === 0 ? res() : rej(new Error(`worker exit ${c}`))));
  }));
}

const px = new Uint8Array(pixels);
const progress = setInterval(() => {
  const d = Atomics.load(doneRows, 0);
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  const eta = d > 0 ? (dt / d) * (height - d) : NaN;
  process.stdout.write(`\r${d}/${height} rows  ${(100 * d / height).toFixed(1)}%  elapsed ${dt.toFixed(0)}s  eta ${isNaN(eta) ? '?' : eta.toFixed(0)}s   `);
}, 2000);

let checkpointTimer = null;
if (args.checkpoint) {
  checkpointTimer = setInterval(() => {
    try { writeFileSync(args.checkpoint, encodePNG(width, height, Buffer.from(px))); } catch {}
  }, args.checkpointSecs * 1000);
}

await Promise.all(workers);
clearInterval(progress);
if (checkpointTimer) clearInterval(checkpointTimer);
const t1 = process.hrtime.bigint();
const wallS = Number(t1 - t0) / 1e9;

const png = encodePNG(width, height, Buffer.from(px));
mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(args.out, png);

const totalPx = width * height;
const totalSamples = totalPx * spp;
console.log(`\ndone in ${wallS.toFixed(2)}s  |  ${(totalPx / wallS).toFixed(0)} px/s  |  ${(totalSamples / wallS / 1e3).toFixed(1)} ksamples/s`);
console.log(`wrote ${args.out} (${png.length} bytes)`);

if (args.bench) {
  // Toolchain identity must be told to us (snapshot.sh exports it); the
  // wasm's directory is this repo, whose HEAD says nothing about the compiler.
  const commit = process.env.TOOLCHAIN_COMMIT || null;
  const result = {
    label: args.label ?? null,
    timestamp: new Date().toISOString(),
    wasm: {
      path: args.wasm,
      bytes: wasmBytes.length,
      sha256: createHash('sha256').update(wasmBytes).digest('hex'),
    },
    settings: { width, height, scene, spp, depth, threads },
    host: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      arch: arch(), platform: platform(),
      node: process.version,
      toolchain_commit: commit,
    },
    timing: {
      wall_s: wallS,
      px_per_s: totalPx / wallS,
      samples_per_s: totalSamples / wallS,
      ns_per_sample: (wallS * 1e9) / totalSamples,
    },
    image: { sha256: createHash('sha256').update(png).digest('hex'), png_bytes: png.length },
  };
  mkdirSync(dirname(resolve(args.bench)), { recursive: true });
  writeFileSync(args.bench, JSON.stringify(result, null, 2) + '\n');
  console.log(`bench -> ${args.bench}`);
}
