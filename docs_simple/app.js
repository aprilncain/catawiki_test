// Minimal, reliable GIF generator.
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
const EXPORT = { w: 1080, h: 608 };

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

function fitContain(srcW, srcH, dstW, dstH) {
  const s = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s;
  const h = srcH * s;
  // Shift anchor to the right: (dstW - drawW) / 0.75
  return { x: (dstW - w) / 0.75, y: (dstH - h) / 2, w, h };
}

function drawFrame(i) {
  const cat = getCategory();
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
  drawFrame(state.active);
  if (!els.autoPlay.checked) return;
  state.timer = setInterval(() => {
    if (state.images.length < 2) return;
    state.active = (state.active + 1) % state.images.length;
    renderThumbs();
    drawFrame(state.active);
  }, PREVIEW_MS);
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

async function encodeGif() {
  if (location.protocol === "file:") {
    throw new Error("Open via localhost (run `node serve.js`) to enable GIF export.");
  }
  const w = EXPORT.w, h = EXPORT.h;
  const frames = [];
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = w;
  exportCanvas.height = h;
  const exportCtx = exportCanvas.getContext("2d", { willReadFrequently: true });
  if (!exportCtx) throw new Error("Export canvas unavailable");

  for (let i = 0; i < state.images.length; i++) {
    drawFrame(i);
    exportCtx.clearRect(0, 0, w, h);
    exportCtx.drawImage(els.canvas, 0, 0, w, h);
    let rgba;
    try {
      rgba = exportCtx.getImageData(0, 0, w, h).data;
    } catch {
      throw new Error("GIF export blocked by browser security. Open via localhost (run `node serve.js`).");
    }
    frames.push({ rgba, delayCs: Math.max(1, Math.round(PREVIEW_MS / 10)) });
  }
  return window.CWGIF.encodeGIF({ width: w, height: h, frames, loop: 0 });
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
      const bytes = await encodeGif();
    const blob = new Blob([bytes], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `catawiki_${state.categoryId || "category"}_${Date.now()}.gif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(`Could not generate GIF. ${e?.message || String(e)}`);
    } finally {
      els.downloadBtn.textContent = prevLabel || "Download GIF";
      els.downloadBtn.disabled = state.images.length === 0;
    }
  });

  onCategoryChanged().catch(() => {});
}

init();
