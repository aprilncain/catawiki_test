// Minimal LinkedIn-style export: preview on canvas, download as MP4/WebM via MediaRecorder.
// Mirrored from docs/simple; only preview transition differs (z-axis + parallax below).
const must = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const els = {
  category: /** @type {HTMLSelectElement} */ (must("category")),
  swatch: must("themeSwatch"),
  dropzone: must("dropzone"),
  fileInput: /** @type {HTMLInputElement} */ (must("fileInput")),
  thumbs: must("thumbs"),
  autoPlay: /** @type {HTMLInputElement} */ (must("autoPlay")),
  downloadBtn: /** @type {HTMLButtonElement} */ (must("downloadBtn")),
  status: must("status"),
  canvas: /** @type {HTMLCanvasElement} */ (must("canvas")),
};

const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
if (!ctx) throw new Error("Canvas 2D unavailable");

const RENDER = { w: 1920, h: 1080 };
const PREVIEW_MS = 500;

/** Full version only: motion tuning (preview + export cycle). */
const MOTION = {
  durationMs: 700,
  holdMs: 2300,
  parallaxX: 36,
  parallaxY: 18,
  zCurrent: 0.14,
  zNext: 0.06,
};

const VIDEO = {
  fps: 30,
  videoBitsPerSecond: 5_000_000,
};

/** @type {{ categories: any[] }} */
// @ts-ignore
const CATS = window.CW_CATEGORIES || { categories: [] };

const state = {
  categoryId: "",
  /** @type {{file: File, url: string, img: HTMLImageElement}[]} */
  images: [],
  active: 0,
  overlay: /** @type {null | HTMLImageElement} */ (null),
  overlayKey: "",
  rafId: /** @type {number | null} */ (null),
  holdTimeout: /** @type {number | null} */ (null),
  gifBytes: /** @type {null | Uint8Array} */ (null),
  encodeToken: 0,
  encoding: false,
};

function setCategoryCss(hex) {
  document.documentElement.style.setProperty("--category", hex);
  els.swatch.style.background = hex;
}

function getCategory() {
  return CATS.categories.find((c) => c.id === state.categoryId) || CATS.categories[0];
}

function normalizeHex(hex) {
  const t = String(hex || "").trim();
  const noHash = t.startsWith("#") ? t.slice(1) : t;
  return /^[0-9a-f]{6}$/i.test(noHash) ? noHash.toUpperCase() : "";
}

function frameCandidates(cat) {
  const out = [];
  if (cat?.frameFile) out.push(String(cat.frameFile));
  const h = normalizeHex(cat?.colors?.accent);
  if (h) out.push(`Frame_${h}.png`, `${h}.png`);
  return Array.from(new Set(out));
}

function loadOverlayForCategory(cat) {
  const candidates = frameCandidates(cat);
  const key = candidates.join("|");
  if (state.overlay && state.overlayKey === key) return Promise.resolve();

  state.overlay = null;
  state.overlayKey = key;

  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      const file = candidates[i++];
      if (!file) return resolve();
      const img = new Image();
      img.onload = () => {
        state.overlay = img;
        resolve();
      };
      img.onerror = () => tryNext();
      img.src = `./assets/${encodeURIComponent(file)}`;
    };
    tryNext();
  });
}

/** Portrait (taller than wide): scale so drawn width = this fraction of frame width (may extend past top/bottom). */
const PORTRAIT_TARGET_WIDTH_RATIO = 0.75;

function fitContain(srcW, srcH, dstW, dstH) {
  const portrait = srcH > srcW;
  let s;
  let w;
  let h;
  if (portrait) {
    w = dstW * PORTRAIT_TARGET_WIDTH_RATIO;
    s = w / srcW;
    h = srcH * s;
  } else {
    s = Math.min(dstW / srcW, dstH / srcH);
    w = srcW * s;
    h = srcH * s;
  }
  return { x: (dstW - w) / 0.75, y: (dstH - h) / 2, w, h };
}

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

function drawImageWith(img, baseFit, opts) {
  const fw = img.naturalWidth || img.width;
  const fh = img.naturalHeight || img.height;
  if (!fw || !fh) return;

  const scale = opts.scale || 1;
  const alpha = opts.alpha === undefined ? 1 : opts.alpha;
  const dx = baseFit.x + (baseFit.w - baseFit.w * scale) / 2 + (opts.offsetX || 0);
  const dy = baseFit.y + (baseFit.h - baseFit.h * scale) / 2 + (opts.offsetY || 0);
  const dw = baseFit.w * scale;
  const dh = baseFit.h * scale;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

function drawComposedFrame(fromIdx, toIdx, t01) {
  ctx.clearRect(0, 0, RENDER.w, RENDER.h);
  const e = easeInOut(Math.max(0, Math.min(1, t01)));

  const from = state.images[fromIdx]?.img || null;
  const to = state.images[toIdx]?.img || null;

  if (to) {
    const fw = to.naturalWidth || to.width;
    const fh = to.naturalHeight || to.height;
    const fit = fitContain(fw, fh, RENDER.w, RENDER.h);
    drawImageWith(to, fit, {
      alpha: e,
      scale: 1 - MOTION.zNext + MOTION.zNext * e,
      offsetX: (0.5 - e) * MOTION.parallaxX,
      offsetY: (0.5 - e) * MOTION.parallaxY,
    });
  }
  if (from) {
    const fw = from.naturalWidth || from.width;
    const fh = from.naturalHeight || from.height;
    const fit = fitContain(fw, fh, RENDER.w, RENDER.h);
    drawImageWith(from, fit, {
      alpha: 1 - e,
      scale: 1 + MOTION.zCurrent * e,
      offsetX: (e - 0.5) * MOTION.parallaxX,
      offsetY: (e - 0.5) * MOTION.parallaxY,
    });
  }

  if (state.overlay) ctx.drawImage(state.overlay, 0, 0, RENDER.w, RENDER.h);
}

function stopPreview() {
  if (state.rafId != null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.holdTimeout != null) {
    clearTimeout(state.holdTimeout);
    state.holdTimeout = null;
  }
}

function startPreview() {
  stopPreview();
  if (!state.images.length) return;
  if (!els.autoPlay.checked || state.images.length < 2) {
    drawComposedFrame(state.active, state.active, 0);
    return;
  }

  const step = (startTs) => {
    const n = state.images.length;
    const fromIdx = state.active % n;
    const toIdx = (state.active + 1) % n;
    const now = performance.now();

    const t = (now - startTs) / MOTION.durationMs;
    if (t < 1) {
      drawComposedFrame(fromIdx, toIdx, t);
      state.rafId = requestAnimationFrame(() => step(startTs));
      return;
    }

    state.active = toIdx;
    renderThumbs();
    drawComposedFrame(state.active, state.active, 0);

    state.holdTimeout = setTimeout(() => {
      if (!els.autoPlay.checked) return;
      state.rafId = requestAnimationFrame(() => step(performance.now()));
    }, MOTION.holdMs);
  };

  state.rafId = requestAnimationFrame(() => step(performance.now()));
}

async function updateGifBytes() {
  state.gifBytes = null;
  els.downloadBtn.disabled = state.images.length === 0;
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  state.images.forEach((it, idx) => {
    const d = document.createElement("div");
    d.className = "thumb" + (idx === state.active ? " isActive" : "");

    const img = document.createElement("img");
    img.src = it.url;
    img.alt = `Uploaded image ${idx + 1}`;

    const rm = document.createElement("div");
    rm.className = "thumb__remove";
    rm.textContent = "×";
    rm.title = "Remove";

    d.appendChild(img);
    d.appendChild(rm);

    d.addEventListener("click", () => {
      state.active = idx;
      renderThumbs();
      drawComposedFrame(state.active, state.active, 0);
    });
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      const removed = state.images.splice(idx, 1)[0];
      URL.revokeObjectURL(removed.url);
      state.active = Math.max(0, Math.min(state.active, state.images.length - 1));
      renderThumbs();
      startPreview();
      drawComposedFrame(state.active, state.active, 0);
      els.downloadBtn.disabled = state.images.length === 0;
    });

    els.thumbs.appendChild(d);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ file, url, img });
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

async function addFiles(fileList) {
  const list = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;

  state.gifBytes = null;
  const remaining = Math.max(0, 5 - state.images.length);
  const toAdd = list.slice(0, remaining);

  for (const f of toAdd) {
    // eslint-disable-next-line no-await-in-loop
    state.images.push(await loadImage(f));
  }

  if (state.active >= state.images.length) state.active = Math.max(0, state.images.length - 1);
  renderThumbs();
  startPreview();
  await updateGifBytes();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickVideoMimeType() {
  const list = [
    "video/mp4; codecs=avc1.4d002a",
    "video/mp4; codecs=avc1.42E01E",
    "video/mp4",
    "video/webm; codecs=vp9",
    "video/webm; codecs=vp8",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of list) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch (_) {
      /* ignore */
    }
  }
  return "";
}

function extForMime(mime) {
  return mime.includes("mp4") ? "mp4" : "webm";
}

/** One full loop through all slides, same timing as preview export. */
async function playOneExportCycleFullMotion() {
  const n = state.images.length;
  if (n < 1) return;
  drawComposedFrame(0, 0, 0);
  await sleep(50);
  for (let i = 0; i < n; i++) {
    const fromIdx = i;
    const toIdx = (i + 1) % n;
    const start = performance.now();
    while (true) {
      const t = (performance.now() - start) / MOTION.durationMs;
      if (t >= 1) {
        drawComposedFrame(toIdx, toIdx, 0);
        break;
      }
      drawComposedFrame(fromIdx, toIdx, Math.min(1, t));
      await new Promise((r) => requestAnimationFrame(r));
    }
    await sleep(MOTION.holdMs);
  }
}

async function exportCanvasToVideoBlob() {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support MediaRecorder (try current Chrome, Edge, or Safari).");
  }
  const mime = pickVideoMimeType();
  if (!mime) {
    throw new Error("No supported video codec for recording in this browser.");
  }

  stopPreview();
  await new Promise((r) => requestAnimationFrame(() => r()));

  drawComposedFrame(state.active, state.active, 0);
  await new Promise((r) => requestAnimationFrame(() => r()));

  const stream = els.canvas.captureStream(VIDEO.fps);
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO.videoBitsPerSecond });
  } catch (_) {
    rec = new MediaRecorder(stream, { mimeType: mime });
  }

  const chunks = /** @type {Blob[]} */ ([]);
  rec.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  const stopped = new Promise((resolve) => {
    rec.addEventListener("stop", () => resolve(), { once: true });
  });

  rec.start(200);
  await playOneExportCycleFullMotion();
  rec.stop();
  await stopped;

  stream.getTracks().forEach((t) => t.stop());
  if (!chunks.length) {
    throw new Error("Recording produced no video data.");
  }
  return { blob: new Blob(chunks, { type: mime }), ext: extForMime(mime) };
}

async function onCategoryChanged() {
  const cat = getCategory();
  setCategoryCss(cat?.colors?.accent || "#0033FF");
  await loadOverlayForCategory(cat);
  startPreview();
  await updateGifBytes();
}

function initCategories() {
  els.category.innerHTML = "";
  for (const c of CATS.categories || []) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    els.category.appendChild(opt);
  }
  state.categoryId = els.category.value || (CATS.categories?.[0]?.id ?? "");
}

function initDnD() {
  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("isOver");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("isOver"));
  els.dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("isOver");
    if (e.dataTransfer?.files) await addFiles(e.dataTransfer.files);
  });
  els.fileInput.addEventListener("change", async () => {
    if (els.fileInput.files) await addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
}

function init() {
  els.canvas.width = RENDER.w;
  els.canvas.height = RENDER.h;
  initCategories();
  initDnD();

  els.category.addEventListener("change", async () => {
    state.categoryId = els.category.value;
    await onCategoryChanged();
  });

  els.autoPlay.addEventListener("change", () => {
    startPreview();
  });

  els.downloadBtn.addEventListener("click", async () => {
    if (!state.images.length) return;
    const prevLabel = els.downloadBtn.textContent;
    els.downloadBtn.disabled = true;
    els.downloadBtn.textContent = "Preparing…";
    try {
      const { blob, ext } = await exportCanvasToVideoBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `catawiki_${state.categoryId || "category"}_${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(`Could not export video. ${e?.message || String(e)}`);
    } finally {
      els.downloadBtn.textContent = prevLabel || "Download video";
      els.downloadBtn.disabled = state.images.length === 0;
      startPreview();
    }
  });

  onCategoryChanged().catch(() => {});
}

init();
