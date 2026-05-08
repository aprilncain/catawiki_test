const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @typedef {{ id: string; label: string; frameFile?: string; colors: { background: string; accent: string; accent2: string; text: string } }} Category */

const state = {
  /** @type {Category[]} */
  categories: [],
  categoryId: "",
  /** @type {{ file: File; url: string; img: HTMLImageElement }[]} */
  images: [],
  /** @type {{ mode: 'builtIn' | 'overlay', overlayImg: HTMLImageElement | null, overlayKey: string | null }} */
  frame: { mode: "overlay", overlayImg: null, overlayKey: null },
  /** @type {Uint8Array | null} */
  lastGif: null,
};

const els = {
  category: /** @type {HTMLSelectElement} */ ($("category")),
  themeSwatch: $("themeSwatch"),
  dropzone: $("dropzone"),
  fileInput: /** @type {HTMLInputElement} */ ($("fileInput")),
  thumbs: $("thumbs"),
  size: /** @type {HTMLSelectElement} */ ($("size")),
  fps: /** @type {HTMLInputElement} */ ($("fps")),
  holdFirst: /** @type {HTMLInputElement} */ ($("holdFirst")),
  holdLast: /** @type {HTMLInputElement} */ ($("holdLast")),
  renderBtn: /** @type {HTMLButtonElement} */ ($("renderBtn")),
  downloadBtn: /** @type {HTMLButtonElement} */ ($("downloadBtn")),
  status: $("status"),
  metaText: $("metaText"),
  canvas: /** @type {HTMLCanvasElement} */ ($("canvas")),
};

const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
if (!ctx) throw new Error("Canvas 2D context unavailable");

function setStatus(msg) {
  els.status.textContent = msg;
}

function parseSize(value) {
  const [w, h] = value.split("x").map((n) => parseInt(n, 10));
  return { w, h };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function getTheme() {
  return state.categories.find((c) => c.id === state.categoryId) || state.categories[0];
}

function applyThemeToUI() {
  const theme = getTheme();
  if (!theme) return;
  document.documentElement.style.setProperty("--accent", theme.colors.accent);
  document.documentElement.style.setProperty("--accent2", withAlpha(theme.colors.accent, 0.22));
  els.themeSwatch.style.background = `linear-gradient(135deg, ${theme.colors.accent}, ${withAlpha(
    theme.colors.accent2,
    0.65,
  )})`;
}

function normalizeHex(s) {
  const t = (s || "").trim();
  if (!t) return "";
  const noHash = t.startsWith("#") ? t.slice(1) : t;
  const m = /^([0-9a-f]{6})$/i.exec(noHash);
  return m ? m[1].toUpperCase() : "";
}

function candidateFrameFiles(theme) {
  const out = [];

  // 1) Explicit config (supports any filename)
  const explicit = (theme?.frameFile || "").trim();
  if (explicit) out.push(explicit);

  // 2) Convention-based names from the category accent color:
  //    - Frame_<HEX>.png  (matches your current exports)
  //    - <HEX>.png        (also supported)
  const hex = normalizeHex(theme?.colors?.accent || "");
  if (hex) {
    out.push(`Frame_${hex}.png`);
    out.push(`${hex}.png`);
  }

  // De-dupe while preserving order
  return Array.from(new Set(out));
}

function loadOverlayFromCategory() {
  const theme = getTheme();
  const candidates = candidateFrameFiles(theme);
  if (!candidates.length) {
    state.frame.overlayImg = null;
    state.frame.overlayKey = null;
    state.frame.mode = "builtIn";
    return Promise.resolve();
  }

  const key = candidates.join("|");
  if (state.frame.overlayKey === key && state.frame.overlayImg) {
    state.frame.mode = "overlay";
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      const file = candidates[i++];
      if (!file) {
        state.frame.overlayImg = null;
        state.frame.overlayKey = null;
        state.frame.mode = "builtIn";
        setStatus(`Couldn’t find a frame PNG in microsite/assets/ for ${theme.label}. Tried: ${candidates.join(", ")}`);
        resolve();
        return;
      }

      const img = new Image();
      img.onload = () => {
        state.frame.overlayImg = img;
        state.frame.overlayKey = key;
        state.frame.mode = "overlay";
        resolve();
      };
      img.onerror = () => tryNext();
      img.src = `./assets/${encodeURIComponent(file)}?v=${encodeURIComponent(theme.id)}`;
    };
    tryNext();
  });
}

async function loadCategories() {
  const res = await fetch("./config/categories.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load categories.json (${res.status})`);
  const json = await res.json();
  state.categories = json.categories || [];
  if (!state.categories.length) throw new Error("No categories found in categories.json");
  state.categoryId = state.categories[0].id;

  els.category.innerHTML = "";
  for (const c of state.categories) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    els.category.appendChild(opt);
  }
  els.category.value = state.categoryId;
  applyThemeToUI();
  await loadOverlayFromCategory();
}

function revokeImageURLs() {
  for (const it of state.images) URL.revokeObjectURL(it.url);
}

function clearImages() {
  revokeImageURLs();
  state.images = [];
  renderThumbs();
  drawPreview();
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ file, url, img });
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

async function addFiles(files) {
  const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;

  setStatus(`Loading ${list.length} image(s)…`);
  const loaded = [];
  for (const f of list) loaded.push(await loadImageFromFile(f));

  state.images = state.images.concat(loaded).slice(0, 5);
  renderThumbs();
  drawPreview();
  setStatus(state.images.length ? `Ready. ${state.images.length} image(s) selected.` : "Ready.");
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  state.images.forEach((it, idx) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.draggable = true;
    d.dataset.index = String(idx);
    d.title = "Drag to reorder · click to remove";

    const img = document.createElement("img");
    img.src = it.url;
    img.alt = `Selected image ${idx + 1}`;

    const badge = document.createElement("div");
    badge.className = "thumb__badge";
    badge.textContent = String(idx + 1);

    const rm = document.createElement("div");
    rm.className = "thumb__remove";
    rm.textContent = "×";

    d.appendChild(img);
    d.appendChild(badge);
    d.appendChild(rm);

    d.addEventListener("click", () => {
      const removed = state.images.splice(idx, 1)[0];
      URL.revokeObjectURL(removed.url);
      renderThumbs();
      drawPreview();
    });

    d.addEventListener("dragstart", (e) => {
      d.classList.add("isDragging");
      e.dataTransfer?.setData("text/plain", String(idx));
      e.dataTransfer?.setDragImage(d, 10, 10);
    });
    d.addEventListener("dragend", () => d.classList.remove("isDragging"));
    d.addEventListener("dragover", (e) => e.preventDefault());
    d.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer?.getData("text/plain") || "-1", 10);
      const to = idx;
      if (from < 0 || from === to) return;
      const [moved] = state.images.splice(from, 1);
      state.images.splice(to, 0, moved);
      renderThumbs();
      drawPreview();
    });

    els.thumbs.appendChild(d);
  });

  els.metaText.textContent = state.images.length
    ? `${state.images.length} image(s) · click to remove · drag to reorder`
    : "No images yet";
}

function setCanvasSize() {
  const { w, h } = parseSize(els.size.value);
  els.canvas.width = w;
  els.canvas.height = h;
  drawPreview();
}

function fitCover(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  let w = dstW, h = dstH, x = 0, y = 0;
  if (srcRatio > dstRatio) {
    h = dstH;
    w = h * srcRatio;
    x = (dstW - w) / 2;
  } else {
    w = dstW;
    h = w / srcRatio;
    y = (dstH - h) / 2;
  }
  return { x, y, w, h };
}

function drawBuiltInFrame(theme, w, h) {
  const pad = Math.round(Math.min(w, h) * 0.06);
  const r = Math.round(Math.min(w, h) * 0.07);
  const innerPad = Math.round(pad * 0.72);

  // frame glow
  ctx.save();
  ctx.shadowColor = withAlpha(theme.colors.accent, 0.55);
  ctx.shadowBlur = Math.round(pad * 1.4);
  ctx.lineWidth = Math.max(6, Math.round(pad * 0.20));
  ctx.strokeStyle = withAlpha(theme.colors.accent, 0.88);
  roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, r);
  ctx.stroke();
  ctx.restore();

  // inner border
  ctx.save();
  ctx.lineWidth = Math.max(2, Math.round(pad * 0.07));
  ctx.strokeStyle = withAlpha(theme.colors.accent2, 0.55);
  roundRect(ctx, pad + innerPad, pad + innerPad, w - (pad + innerPad) * 2, h - (pad + innerPad) * 2, r * 0.8);
  ctx.stroke();
  ctx.restore();

  // top notch / label
  const labelW = Math.round((w - pad * 2) * 0.62);
  const labelH = Math.max(34, Math.round(pad * 0.55));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.strokeStyle = withAlpha(theme.colors.accent, 0.45);
  ctx.lineWidth = 1;
  roundRect(ctx, pad + innerPad, pad + innerPad, labelW, labelH, Math.round(labelH / 2));
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = withAlpha(theme.colors.text, 0.92);
  ctx.font = `600 ${Math.max(16, Math.round(labelH * 0.42))}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.fillText(theme.label.toUpperCase(), pad + innerPad + Math.round(labelH * 0.55), pad + innerPad + Math.round(labelH / 2));
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawBackground(theme, w, h) {
  // base
  ctx.fillStyle = theme.colors.background;
  ctx.fillRect(0, 0, w, h);

  // gradient blobs
  const g1 = ctx.createRadialGradient(w * 0.18, h * 0.15, 10, w * 0.18, h * 0.15, Math.max(w, h) * 0.72);
  g1.addColorStop(0, withAlpha(theme.colors.accent, 0.28));
  g1.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, w, h);

  const g2 = ctx.createRadialGradient(w * 0.92, h * 0.28, 10, w * 0.92, h * 0.28, Math.max(w, h) * 0.70);
  g2.addColorStop(0, withAlpha(theme.colors.accent2, 0.18));
  g2.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);

  // subtle noise (deterministic)
  const n = Math.round(Math.min(w, h) * 0.02);
  for (let i = 0; i < 22; i++) {
    const x = ((i * 97) % (w + n)) - n;
    const y = ((i * 193) % (h + n)) - n;
    ctx.fillStyle = `rgba(255,255,255,${0.010 + (i % 5) * 0.002})`;
    ctx.fillRect(x, y, n, n);
  }
}

function drawImageInWindow(img, w, h) {
  const pad = Math.round(Math.min(w, h) * 0.095);
  const windowX = pad;
  const windowY = pad;
  const windowW = w - pad * 2;
  const windowH = h - pad * 2;
  const r = Math.round(Math.min(w, h) * 0.06);

  // window mask
  ctx.save();
  roundRect(ctx, windowX, windowY, windowW, windowH, r);
  ctx.clip();

  const fit = fitCover(img.naturalWidth || img.width, img.naturalHeight || img.height, windowW, windowH);
  ctx.drawImage(img, windowX + fit.x, windowY + fit.y, fit.w, fit.h);

  // top fade for readability
  const fade = ctx.createLinearGradient(0, windowY, 0, windowY + windowH * 0.22);
  fade.addColorStop(0, "rgba(0,0,0,.45)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(windowX, windowY, windowW, windowH * 0.22);

  ctx.restore();
}

function drawOverlayIfAny(w, h) {
  if (state.frame.mode !== "overlay" || !state.frame.overlayImg) return;
  ctx.drawImage(state.frame.overlayImg, 0, 0, w, h);
}

function drawPreview(frameIdx = 0) {
  const theme = getTheme();
  const w = els.canvas.width;
  const h = els.canvas.height;

  drawBackground(theme, w, h);
  const img = state.images[frameIdx]?.img;
  if (img) drawImageInWindow(img, w, h);
  if (state.frame.mode === "builtIn") drawBuiltInFrame(theme, w, h);
  drawOverlayIfAny(w, h);
}

function delayMsToCs(ms) {
  return Math.max(1, Math.round(ms / 10));
}

async function renderGif() {
  if (state.images.length < 1) {
    setStatus("Add at least 1 image.");
    return;
  }
  if (state.images.length > 5) state.images = state.images.slice(0, 5);

  const { w, h } = parseSize(els.size.value);
  els.canvas.width = w;
  els.canvas.height = h;

  const fps = Math.max(1, Math.min(20, parseFloat(els.fps.value || "6")));
  const perFrameMs = 1000 / fps;
  const holdFirst = Math.max(0, Math.min(5000, parseInt(els.holdFirst.value || "0", 10)));
  const holdLast = Math.max(0, Math.min(5000, parseInt(els.holdLast.value || "0", 10)));

  setStatus("Rendering frames…");
  const frames = [];

  for (let i = 0; i < state.images.length; i++) {
    drawPreview(i);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    let delay = perFrameMs;
    if (i === 0) delay += holdFirst;
    if (i === state.images.length - 1) delay += holdLast;
    frames.push({ rgba, delayCs: delayMsToCs(delay) });
  }

  setStatus("Encoding GIF… (this can take a few seconds)");
  await tick();
  const bytes = window.CWGIF.encodeGIF({ width: w, height: h, frames, loop: 0 });
  state.lastGif = bytes;
  els.downloadBtn.disabled = false;
  setStatus(`Done. ${Math.round(bytes.length / 1024)} KB`);
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function downloadGif() {
  if (!state.lastGif) return;
  const theme = getTheme();
  const blob = new Blob([state.lastGif], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `catawiki_${theme?.id || "category"}_${Date.now()}.gif`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function setupDnD() {
  const dz = els.dropzone;
  const input = els.fileInput;
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("isOver");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("isOver"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("isOver");
    const files = e.dataTransfer?.files;
    if (files) await addFiles(files);
  });
  input.addEventListener("change", async () => {
    if (input.files) await addFiles(input.files);
    input.value = "";
  });
}

function bindUI() {
  els.category.addEventListener("change", async () => {
    state.categoryId = els.category.value;
    applyThemeToUI();
    await loadOverlayFromCategory();
    drawPreview();
  });
  els.size.addEventListener("change", setCanvasSize);
  els.renderBtn.addEventListener("click", renderGif);
  els.downloadBtn.addEventListener("click", downloadGif);
}

async function main() {
  setStatus("Loading…");
  await loadCategories();
  setupDnD();
  bindUI();
  renderThumbs();
  drawPreview();
  setStatus("Ready. Add 3–5 images to start.");
}

window.addEventListener("beforeunload", () => revokeImageURLs());
main().catch((e) => {
  console.error(e);
  setStatus(`Error: ${e?.message || String(e)}`);
});
