(() => {
"use strict";

const MAXDIM = 2600;        // grand côté du rendu final
const MAXSRC = 4000;        // grand côté de la source échantillonnée
const BUDGET = 1_900_000;   // sous 2 Mo dans les deux définitions
const RESERVE = 8192;       // structure PDF

const $ = (id) => document.getElementById(id);
const grid = $("grid"), pick = $("pick"), statusEl = $("status");
const addBtn = $("addBtn"), makeBtn = $("makeBtn"), colorChk = $("colorChk");
const resultEl = $("result"), resultInfo = $("resultInfo"), histEl = $("hist");

const state = { pages: [], color: false, busy: false, pdf: null };

// ---------- utilitaires ----------
const raf2 = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const setStatus = (t) => { statusEl.textContent = t; };
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
const mk = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

// le cookie de session part seul (même origine) ; 401 = session expirée
async function api(url, opt) {
  const r = await fetch(url, opt);
  if (r.status === 401) { location.replace("/login"); throw new Error("session expirée"); }
  return r;
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("format non supporté")); };
    img.src = url;
  });
}

// ---------- estimation des coins ----------
function guessCorners(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const fallback = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]
    .map(([x, y]) => [x * W, y * H]);
  try {
    const s = Math.min(1, 200 / Math.max(W, H));
    const w = Math.max(4, Math.round(W * s)), h = Math.max(4, Math.round(H * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const lum = (x, y) => { const i = (y * w + x) * 4; return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; };

    const border = [];
    for (let x = 0; x < w; x++) { border.push(lum(x, 0), lum(x, h - 1)); }
    for (let y = 0; y < h; y++) { border.push(lum(0, y), lum(w - 1, y)); }
    border.sort((a, b) => a - b);
    const bg = border[border.length >> 1];

    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.abs(lum(x, y) - bg) > 45) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        n++;
      }
    }
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (n > w * h * 0.08 && area > w * h * 0.25 && x1 > x0 && y1 > y0) {
      const k = 1 / s, pad = 3;
      return [
        [x0 - pad, y0 - pad], [x1 + pad, y0 - pad],
        [x1 + pad, y1 + pad], [x0 - pad, y1 + pad],
      ].map(([x, y]) => [clamp(x * k, 0, W), clamp(y * k, 0, H)]);
    }
  } catch (_) { /* repli */ }
  return fallback;
}

// ---------- rendu scanner ----------
function scanify(ctx, w, h, color) {
  const im = ctx.getImageData(0, 0, w, h);
  flattenBackground(im.data, w, h);
  scanLUT(im.data, w * h, color);
  ctx.putImageData(im, 0, 0);
}

// ---------- redressement ----------
async function warp(page) {
  const { img, url } = await loadImage(page.file);
  const W = img.naturalWidth, H = img.naturalHeight;
  const sc = Math.min(1, MAXSRC / Math.max(W, H));
  const sw = Math.max(1, Math.round(W * sc)), sh = Math.max(1, Math.round(H * sc));

  const srcC = document.createElement("canvas");
  srcC.width = sw; srcC.height = sh;
  const sctx = srcC.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, sw, sh);
  URL.revokeObjectURL(url);
  const src = sctx.getImageData(0, 0, sw, sh).data;
  srcC.width = srcC.height = 0;

  const q = page.corners.map(([x, y]) => [x * sc, y * sc]);
  const ow0 = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const oh0 = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, MAXDIM / Math.max(ow0, oh0));
  const ow = Math.max(8, Math.round(ow0 * k));
  const oh = Math.max(8, Math.round(oh0 * k));

  const out = document.createElement("canvas");
  out.width = ow; out.height = oh;
  const octx = out.getContext("2d", { willReadFrequently: true });

  const M = perspective([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);
  const dst = octx.createImageData(ow, oh);
  sampleBilinear(src, sw, sh, M, dst.data, ow, oh);
  octx.putImageData(dst, 0, 0);
  scanify(octx, ow, oh, state.color);
  return out;
}

// ---------- éditeur de recadrage ----------
const ed = {
  el: $("editor"), img: $("edImg"), canvas: $("edCanvas"), stage: $("stage"),
  srcImg: null, srcUrl: null, corners: null, idx: -1, drag: -1, box: null, dpr: 1, ctx: null,
};

async function openEditor(i) {
  const page = state.pages[i];
  if (!page) return;
  let img, url;
  try { ({ img, url } = await loadImage(page.file)); }
  catch (e) { return setStatus("Photo illisible : " + e.message); }
  if (ed.srcUrl) URL.revokeObjectURL(ed.srcUrl);
  ed.srcImg = img; ed.srcUrl = url; ed.idx = i;
  ed.corners = page.corners.map((p) => p.slice());
  ed.el.hidden = false;
  ed.img.src = url;
  try { await ed.img.decode(); } catch (_) {}
  layoutEditor();
}

function closeEditor() {
  ed.el.hidden = true;
  if (ed.srcUrl) { URL.revokeObjectURL(ed.srcUrl); ed.srcUrl = null; }
  ed.srcImg = null; ed.idx = -1; ed.drag = -1;
}

function layoutEditor() {
  const r = ed.stage.getBoundingClientRect();
  if (!r.width || !ed.srcImg) return;
  const iw = ed.srcImg.naturalWidth, ih = ed.srcImg.naturalHeight;
  const s = Math.min(r.width / iw, r.height / ih);
  const w = iw * s, h = ih * s;
  ed.box = { x: (r.width - w) / 2, y: (r.height - h) / 2, s };
  ed.dpr = Math.min(2, window.devicePixelRatio || 1);
  ed.canvas.width = Math.round(r.width * ed.dpr);
  ed.canvas.height = Math.round(r.height * ed.dpr);
  ed.canvas.style.width = r.width + "px";
  ed.canvas.style.height = r.height + "px";
  ed.ctx = ed.canvas.getContext("2d");
  drawEditor();
}

function drawEditor() {
  const c = ed.ctx, box = ed.box;
  if (!c || !box) return;
  const W = ed.canvas.width / ed.dpr, H = ed.canvas.height / ed.dpr;
  c.setTransform(ed.dpr, 0, 0, ed.dpr, 0, 0);
  c.clearRect(0, 0, W, H);

  const pts = ed.corners.map(([x, y]) => [box.x + x * box.s, box.y + y * box.s]);

  c.beginPath();
  c.rect(0, 0, W, H);
  pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.fillStyle = "rgba(0,0,0,.5)";
  c.fill("evenodd");

  c.beginPath();
  pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.strokeStyle = "#3b82f6";
  c.lineWidth = 2;
  c.stroke();

  for (const [x, y] of pts) {
    c.beginPath(); c.arc(x, y, 14, 0, 7); c.fillStyle = "rgba(59,130,246,.28)"; c.fill();
    c.beginPath(); c.arc(x, y, 7, 0, 7); c.fillStyle = "#fff"; c.fill();
    c.strokeStyle = "#3b82f6"; c.lineWidth = 2.5; c.stroke();
  }
}

function pointerPos(e) {
  const r = ed.canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

ed.canvas.addEventListener("pointerdown", (e) => {
  const [px, py] = pointerPos(e);
  let best = -1, bd = 46;
  ed.corners.forEach(([cx, cy], k) => {
    const dd = Math.hypot(px - (ed.box.x + cx * ed.box.s), py - (ed.box.y + cy * ed.box.s));
    if (dd < bd) { bd = dd; best = k; }
  });
  if (best >= 0) {
    ed.drag = best;
    ed.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});

ed.canvas.addEventListener("pointermove", (e) => {
  if (ed.drag < 0) return;
  const [px, py] = pointerPos(e);
  const W = ed.srcImg.naturalWidth, H = ed.srcImg.naturalHeight;
  ed.corners[ed.drag] = [
    clamp((px - ed.box.x) / ed.box.s, 0, W),
    clamp((py - ed.box.y) / ed.box.s, 0, H),
  ];
  drawEditor();
  e.preventDefault();
});

const endDrag = () => { ed.drag = -1; };
ed.canvas.addEventListener("pointerup", endDrag);
ed.canvas.addEventListener("pointercancel", endDrag);
window.addEventListener("resize", () => { if (!ed.el.hidden) layoutEditor(); });

$("edCancel").addEventListener("click", closeEditor);

$("edOk").addEventListener("click", async () => {
  const i = ed.idx, page = state.pages[i];
  if (!page) return;
  page.corners = ed.corners.map((p) => p.slice());
  $("edOk").textContent = "…";
  try {
    setStatus("Redressement…");
    await raf2();
    page.canvas = await warp(page);
  } catch (e) {
    setStatus("Erreur : " + e.message);
  } finally {
    $("edOk").textContent = "Valider";
  }
  closeEditor();
  setStatus("");
  render();
  invalidate();
});

// ---------- liste des pages ----------
function render() {
  grid.textContent = "";
  state.pages.forEach((p, i) => {
    const fig = document.createElement("figure");
    fig.className = "page";
    if (p.canvas) fig.append(p.canvas);
    else { const ph = document.createElement("div"); ph.className = "ph"; fig.append(ph); }

    const num = document.createElement("span");
    num.className = "num"; num.textContent = i + 1;
    fig.append(num);

    const del = document.createElement("button");
    del.className = "del"; del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", "Supprimer la page " + (i + 1));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      state.pages.splice(i, 1);
      render(); invalidate();
    });
    fig.append(del);

    // réordonnancement par flèches : le glisser-déposer tactile est fragile sur Safari
    const mv = (dir, label) => {
      const b = document.createElement("button");
      b.className = "mv " + (dir < 0 ? "prev" : "next");
      b.type = "button";
      b.textContent = dir < 0 ? "\u2039" : "\u203a";
      b.setAttribute("aria-label", label);
      b.disabled = dir < 0 ? i === 0 : i === state.pages.length - 1;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const j = i + dir;
        [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
        render(); invalidate();
      });
      fig.append(b);
    };
    mv(-1, `Déplacer la page ${i + 1} vers la gauche`);
    mv(1, `Déplacer la page ${i + 1} vers la droite`);

    fig.addEventListener("click", () => openEditor(i));
    grid.append(fig);
  });
  sync();
}

function sync() {
  const n = state.pages.length;
  addBtn.textContent = n ? "Ajouter une page" : "Ajouter une photo";
  makeBtn.textContent = n ? `Créer le PDF (${n} page${n > 1 ? "s" : ""})` : "Créer le PDF";
  makeBtn.disabled = n === 0 || state.busy;
  addBtn.disabled = state.busy;
}

function invalidate() {
  state.pdf = null;
  resultEl.hidden = true;
}

// ---------- ajout ----------
addBtn.addEventListener("click", () => pick.click());

pick.addEventListener("change", async () => {
  const files = [...pick.files];
  pick.value = "";
  if (!files.length) return;
  state.busy = true; sync();
  for (let i = 0; i < files.length; i++) {
    setStatus(`Lecture ${i + 1}/${files.length}…`);
    await raf2();
    try {
      const { img, url } = await loadImage(files[i]);
      const corners = guessCorners(img);
      const page = { file: files[i], corners, canvas: null };
      URL.revokeObjectURL(url);
      page.canvas = await warp(page);
      state.pages.push(page);
      render(); invalidate();
    } catch (e) {
      setStatus("Photo ignorée : " + e.message);
    }
  }
  state.busy = false; sync();
  invalidate();
  if (files.length === 1 && state.pages.length) {
    setStatus("");
    openEditor(state.pages.length - 1);
  } else {
    setStatus(state.pages.length ? "Appuie sur une page pour recadrer." : "");
  }
});

// ---------- encodage ----------
function encodeAt(src, maxDim, q) {
  const s = Math.min(1, maxDim / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  let c = src;
  if (w !== src.width || h !== src.height) {
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(src, 0, 0, w, h);
  }
  return new Promise((res, rej) => {
    c.toBlob((blob) => {
      if (c !== src) c.width = c.height = 0;
      if (!blob) return rej(new Error("encodage JPEG impossible"));
      res({ blob, w, h });
    }, "image/jpeg", q);
  });
}

async function optimize() {
  const budget = BUDGET - RESERVE;
  let dims = MAXDIM, q = 0.82, last = null;
  for (let pass = 0; pass < 7; pass++) {
    setStatus(`Optimisation… (${Math.round(q * 100)} %)`);
    await raf2();
    const enc = [];
    for (const p of state.pages) enc.push(await encodeAt(p.canvas, dims, q));
    last = enc;
    const total = enc.reduce((s, e) => s + e.blob.size, 0);
    if (total <= budget) break;
    if (q > 0.45) q = q > 0.6 ? q - 0.14 : q - 0.1;
    else { dims = Math.round(dims * 0.78); q = 0.68; }
  }
  setStatus("");
  return last;
}

// ---------- génération ----------
makeBtn.addEventListener("click", async () => {
  if (!state.pages.length || state.busy) return;
  state.busy = true; sync(); invalidate();
  try {
    const enc = await optimize();
    const pdfPages = [];
    for (const e of enc) {
      pdfPages.push({ bytes: new Uint8Array(await e.blob.arrayBuffer()), width: e.w, height: e.h });
    }
    const bytes = buildPdf(pdfPages);
    const blob = new Blob([bytes], { type: "application/pdf" });
    state.pdf = { blob, name: `scan-${stamp()}.pdf` };

    const mb = (blob.size / 1048576).toFixed(2).replace(".", ",");
    const over = blob.size > 2 * 1024 * 1024;
    resultInfo.innerHTML = `<b>PDF prêt</b> · ${state.pages.length} page${state.pages.length > 1 ? "s" : ""} · ${mb} Mo${over ? " ⚠️ au-delà de 2 Mo" : ""}`;
    resultEl.hidden = false;
  } catch (e) {
    console.error(e);
    setStatus("Erreur : " + (e.message || e));
  } finally {
    state.busy = false; sync();
  }
});

// ---------- partage / envoi ----------
$("shareBtn").addEventListener("click", async () => {
  if (!state.pdf) return;
  const file = new File([state.pdf.blob], state.pdf.name, { type: "application/pdf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: state.pdf.name }); }
    catch (e) { if (e.name !== "AbortError") setStatus("Partage impossible : " + e.message); }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

$("saveBtn").addEventListener("click", async () => {
  if (!state.pdf) return;
  const btn = $("saveBtn");
  btn.disabled = true; btn.textContent = "Envoi…";
  try {
    const r = await api("api/upload",
      { method: "POST", headers: { "Content-Type": "application/pdf" }, body: state.pdf.blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    setStatus("Enregistré : " + j.file);
  } catch (e) {
    setStatus("Envoi impossible : " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Envoyer sur le serveur";
  }
});

// ---------- couleur ----------
colorChk.addEventListener("change", async () => {
  state.color = colorChk.checked;
  if (!state.pages.length) return;
  state.busy = true; sync(); invalidate();
  try {
    for (let i = 0; i < state.pages.length; i++) {
      setStatus(`Rendu ${i + 1}/${state.pages.length}…`);
      await raf2();
      state.pages[i].canvas = await warp(state.pages[i]);
    }
    render(); invalidate();
    setStatus("");
  } catch (e) {
    setStatus("Erreur : " + e.message);
  } finally {
    state.busy = false; sync();
  }
});

// ---------- historique serveur ----------
const fmtSize = (n) => (n / 1048576).toFixed(2).replace(".", ",") + " Mo";

function renderHist(files) {
  histEl.textContent = "";
  if (!files.length) { histEl.append(mk("p", "Aucun PDF sur le serveur.")); return; }
  for (const f of files) {
    const row = mk("div", null, "hrow");
    const open = mk("button", null, "hopen");
    open.type = "button";
    open.title = f.file;
    const when = new Date(f.mtime * 1000)
      .toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    open.append(mk("b", when), mk("span", fmtSize(f.size)));
    open.addEventListener("click", () => openScan(f, open));
    const del = mk("button", "×", "hdel");
    del.type = "button";
    del.setAttribute("aria-label", "Supprimer " + f.file);
    del.addEventListener("click", () => deleteScan(f));
    row.append(open, del);
    histEl.append(row);
  }
}

async function openScan(f, btn) {
  btn.disabled = true;
  try {
    const r = await api("api/scans/" + encodeURIComponent(f.file));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const url = URL.createObjectURL(await r.blob());
    // Safari peut refuser window.open hors du geste : repli sur un lien
    if (!window.open(url, "_blank")) {
      const a = mk("a"); a.href = url; a.download = f.file; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    setStatus("Ouverture impossible : " + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteScan(f) {
  if (!confirm("Supprimer " + f.file + " du serveur ?")) return;
  try {
    const r = await api("api/scans/" + encodeURIComponent(f.file), { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    loadHist();
  } catch (e) {
    setStatus("Suppression impossible : " + e.message);
  }
}

async function loadHist() {
  histEl.hidden = false;
  histEl.textContent = "Chargement…";
  try {
    const r = await api("api/scans");
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    renderHist(j.files || []);
  } catch (e) {
    histEl.textContent = "";
    histEl.append(mk("p", "Historique indisponible : " + e.message));
  }
}

$("histBtn").addEventListener("click", () => {
  if (histEl.hidden) loadHist();
  else histEl.hidden = true;
});

sync();
})();
