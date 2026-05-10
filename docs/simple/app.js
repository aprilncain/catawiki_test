// Minimal canvas preview; download as MP4/WebM via MediaRecorder.
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
/** How long each slide stays on screen in autoplay and in video export (simple build). */
const SLIDE_HOLD_MS = 1500;

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
  timer: /** @type {any} */ (null),
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

/**
 * Reference dimensions that looked correct in the frame (contain fit on dst).
 * Every image uses at least this scale so nothing appears smaller than that photo.
 */
const REF_CONTAIN_SIZE = { w: 1226, h: 935 };

/** Portrait (taller than wide): also require at least this draw-width vs frame (can extend vertically). */
const PORTRAIT_TARGET_WIDTH_RATIO = 0.75;

/** Horizontal centre of the image (1920×1080 stage); left edge = this minus half draw width. */
const IMAGE_ANCHOR_X = 1125;

function fitContain(srcW, srcH, dstW, dstH) {
  if (!srcW || !srcH) return { x: 0, y: 0, w: 0, h: 0 };
  const sRef = Math.min(dstW / REF_CONTAIN_SIZE.w, dstH / REF_CONTAIN_SIZE.h);
  let s = Math.min(dstW / srcW, dstH / srcH);
  s = Math.max(s, sRef);
  if (srcH > srcW) {
    const sPortraitW = (dstW * PORTRAIT_TARGET_WIDTH_RATIO) / srcW;
    s = Math.max(s, sPortraitW);
  }
  const w = srcW * s;
  const h = srcH * s;
  return { x: IMAGE_ANCHOR_X - w / 2, y: (dstH - h) / 2, w, h };
}

function drawFrame(i) {
  ctx.clearRect(0, 0, RENDER.w, RENDER.h);

  const img = state.images[i]?.img;
  if (img) {
    const fw = img.naturalWidth || img.width;
    const fh = img.naturalHeight || img.height;
    const fit = fitContain(fw, fh, RENDER.w, RENDER.h);
    ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  }

  if (state.overlay) ctx.drawImage(state.overlay, 0, 0, RENDER.w, RENDER.h);
}

function startPreview() {
  if (state.timer) clearInterval(state.timer);
  if (!state.images.length) return;
  if (els.autoPlay.checked) {
    state.active = 0;
    renderThumbs();
  }
  drawFrame(state.active);
  if (!els.autoPlay.checked) return;
  state.timer = setInterval(() => {
    if (state.images.length < 2) return;
    state.active = (state.active + 1) % state.images.length;
    renderThumbs();
    drawFrame(state.active);
  }, SLIDE_HOLD_MS);
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
      drawFrame(state.active);
    });
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      const removed = state.images.splice(idx, 1)[0];
      URL.revokeObjectURL(removed.url);
      state.active = Math.max(0, Math.min(state.active, state.images.length - 1));
      renderThumbs();
      startPreview();
      drawFrame(state.active);
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

  // Append up to 5 total
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

/**
 * One export pass: first → last, each held SLIDE_HOLD_MS (matches autoplay order).
 * Caller must already have drawn slide 0 on the canvas; we hold it once, then 1…n−1.
 */
async function playOneExportCycleSimple() {
  const n = state.images.length;
  if (n < 1) return;
  await sleep(SLIDE_HOLD_MS);
  for (let i = 1; i < n; i++) {
    drawFrame(i);
    await sleep(SLIDE_HOLD_MS);
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

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  await new Promise((r) => requestAnimationFrame(() => r()));

  state.active = 0;
  renderThumbs();
  drawFrame(0);
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
  await playOneExportCycleSimple();
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
