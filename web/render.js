// Web harness for the Inference ray tracer. RENDERING GLUE ONLY — there is no
// ray-tracing logic here: every colour comes from wasm `render_pixel`. JS just
// loops pixels, unpacks the i64/BigInt result into RGBA, and paints the canvas.

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const W = canvas.width, H = canvas.height;
const $ = (id) => document.getElementById(id);

let exportsP = null;
async function getWasm() {
  if (!exportsP) {
    const res = await fetch('./main.wasm', { cache: 'no-store' });
    const bytes = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    exportsP = instance.exports;
    if (exportsP.abi_version) $('abi').textContent = 'wasm ABI v' + exportsP.abi_version();
  }
  return exportsP;
}

// Wire range -> output labels.
for (const [inp, out] of [['samples', 'samplesOut'], ['depth', 'depthOut'], ['rscale', 'rscaleOut']]) {
  const i = $(inp), o = $(out);
  o.textContent = i.value;
  i.addEventListener('input', () => (o.textContent = i.value));
}

let token = 0;
const state = { rendering: false, progress: 0, done: false };
window.__rt = state; // test introspection

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const setStatus = (s) => ($('status').textContent = s);
const setProgress = (p) => { state.progress = p; $('prog').value = Math.round(p * 100); };

async function render(opts = {}) {
  const myToken = ++token;          // cancels any in-flight render
  state.rendering = true; state.done = false;
  $('render').disabled = true; $('stop').disabled = false;

  const ex = await getWasm();
  const samples = BigInt(opts.samples ?? $('samples').value);
  const depth = BigInt(opts.depth ?? $('depth').value);
  const scene = BigInt(opts.scene ?? $('scene').value);
  const step = Math.max(1, parseInt(opts.step ?? $('rscale').value, 10));

  const Wb = BigInt(W), Hb = BigInt(H);
  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  const rp = ex.render_pixel;

  const totalRows = Math.ceil(H / step);
  const t0 = performance.now();
  setStatus('rendering…');

  let rowIdx = 0;
  for (let y = 0; y < H; y += step) {
    if (myToken !== token) { state.rendering = false; return; } // cancelled
    for (let x = 0; x < W; x += step) {
      const packed = Number(rp(BigInt(x), BigInt(y), Wb, Hb, samples, depth, scene) & 0xFFFFFFn);
      const r = (packed >> 16) & 255, g = (packed >> 8) & 255, b = packed & 255;
      const xe = Math.min(x + step, W), ye = Math.min(y + step, H);
      for (let yy = y; yy < ye; yy++) {
        let o = (yy * W + x) * 4;
        for (let xx = x; xx < xe; xx++) { data[o++] = r; data[o++] = g; data[o++] = b; data[o++] = 255; }
      }
    }
    rowIdx++;
    setProgress(rowIdx / totalRows);
    if ((rowIdx & 3) === 0 || rowIdx === totalRows) {
      ctx.putImageData(img, 0, 0);
      const el = (performance.now() - t0) / 1000;
      setStatus(`${Math.round((rowIdx / totalRows) * 100)}%  ·  ${el.toFixed(1)}s`);
      await nextFrame();
    }
  }
  ctx.putImageData(img, 0, 0);
  const el = (performance.now() - t0) / 1000;
  setStatus(`done  ·  ${el.toFixed(1)}s`);
  setProgress(1);
  state.rendering = false; state.done = true;
  $('render').disabled = false; $('stop').disabled = true;
}

$('render').addEventListener('click', () => render());
$('stop').addEventListener('click', () => {
  token++; state.rendering = false;
  setStatus('stopped'); $('render').disabled = false; $('stop').disabled = true;
});

// Eagerly load the wasm on page load (populates the ABI banner) and, unless
// disabled with ?auto=0, paint an instant low-quality preview so the page is
// never blank.
const params = new URLSearchParams(location.search);
window.addEventListener('load', () => {
  getWasm();
  if (params.get('auto') !== '0') render({ samples: 4, depth: 8, step: 6 });
});
