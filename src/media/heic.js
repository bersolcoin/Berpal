/**
 * HEIC / HEIF → JPEG, so iPhone photos sent as documents (WhatsApp converts camera photos itself,
 * but "send as file" keeps the original HEIC) go through the same vision scan as a JPEG.
 *
 * heic-convert is pure JS (libheif compiled to JS/wasm) — no native build. Decoding is CPU-bound
 * (≈1.6 s for a 12 MP / 3.8 MB iPhone-sized HEIC on an M-series Mac), so it runs in a
 * worker_threads Worker: the event loop keeps serving other senders meanwhile, and on timeout the
 * worker is terminated — the CPU is actually reclaimed, not just the wait. One short-lived worker
 * per conversion (HEICs are rare; startup is ~100 ms). The download cap (MEDIA_MAX_BYTES) applies
 * to the original HEIC before it gets here.
 *
 * This file is also the worker's entry point (see the bottom).
 */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const CONVERT_TIMEOUT_MS = 15000;
const JPEG_QUALITY = 0.85;
// Decoded RGBA for a 12 MP photo is ~48 MB plus the decoder's wasm heap; cap the worker's JS heap
// so a hostile file fails the conversion instead of growing the process without bound.
const WORKER_HEAP_MB = 512;

class HeicConvertError extends Error {
  constructor(message) {
    super(`HEIC conversion failed: ${message}`);
    this.code = 'HEIC_CONVERT_FAILED';
  }
}

let _impl = null;

/** Run heic-convert in a fresh Worker; reject (and terminate it) after timeoutMs. */
function convertInWorker(bytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(__filename, {
      workerData: { heicWorker: true, buffer: bytes, quality: JPEG_QUALITY },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new HeicConvertError(`timed out after ${timeoutMs}ms`)), timeoutMs);
    worker.once('message', (msg) => {
      if (msg && msg.ok) done(resolve, Buffer.from(msg.jpeg));
      else done(reject, new HeicConvertError((msg && msg.error) || 'decoder failed'));
    });
    worker.once('error', (err) => done(reject, new HeicConvertError(err && err.message ? err.message : String(err))));
    worker.once('exit', (code) => done(reject, new HeicConvertError(`decoder exited (code ${code})`)));
  });
}

/** Tests' in-process stub path: the timeout bounds the wait only. */
async function convertInProcess(convert, bytes, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HeicConvertError(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => convert({ buffer: bytes, format: 'JPEG', quality: JPEG_QUALITY })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve to JPEG bytes (Buffer); throws HeicConvertError on bad input, decoder error or timeout. */
async function heicToJpeg(bytes, { timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const out = _impl ? await convertInProcess(_impl, bytes, timeoutMs) : await convertInWorker(bytes, timeoutMs);
    const jpeg = Buffer.from(out);
    if (!jpeg.length) throw new HeicConvertError('decoder returned no data');
    const { ts } = require('../erp-sync/common'); // lazy: keeps the worker's require graph to heic-convert
    console.log(`• [media] [${ts()}] converted HEIC ${bytes.length} → JPEG ${jpeg.length} bytes in ${Date.now() - started}ms`);
    return jpeg;
  } catch (err) {
    if (err instanceof HeicConvertError) throw err;
    throw new HeicConvertError(err && err.message ? err.message : String(err));
  }
}

/** Tests only: replace the converter with ({ buffer, format, quality }) => bytes (run in-process). null restores the worker. */
function _setConverterForTests(fn) {
  _impl = fn || null;
}

module.exports = { heicToJpeg, HeicConvertError, CONVERT_TIMEOUT_MS, _setConverterForTests };

// ── worker entry point ───────────────────────────────────────────────
if (!isMainThread && workerData && workerData.heicWorker) {
  (async () => {
    try {
      const convert = require('heic-convert');
      const out = await convert({ buffer: Buffer.from(workerData.buffer), format: 'JPEG', quality: workerData.quality });
      const jpeg = new Uint8Array(out);
      parentPort.postMessage({ ok: true, jpeg }, [jpeg.buffer]);
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
}
