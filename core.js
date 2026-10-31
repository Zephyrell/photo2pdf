/*
 * Math + traitement d'image, sans DOM. Chargé avant app.js, testé par test-core.cjs.
 */

// système linéaire n×n (élimination de Gauss, pivot partiel)
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (p !== i) { const t = A[i]; A[i] = A[p]; A[p] = t; const u = b[i]; b[i] = b[p]; b[p] = u; }
    const piv = A[i][i];
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / piv;
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : s / A[i][i];
  }
  return x;
}

// matrice 3×3 (9 coeffs) qui envoie les 4 points src sur les 4 points dst
function perspective(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// échantillonnage bilinéaire : pour chaque pixel de sortie, applique M puis lit src
function sampleBilinear(src, sw, sh, M, out, ow, oh) {
  const [a, b, c, d, e, f, g, h] = M;
  const maxx = sw - 1, maxy = sh - 1;
  let o = 0;
  for (let y = 0; y < oh; y++) {
    const by = b * y + c, ey = e * y + f, hy = h * y + 1;
    for (let x = 0; x < ow; x++) {
      const den = g * x + hy;
      let u = (a * x + by) / den;
      let v = (d * x + ey) / den;
      if (!(u >= 0)) u = 0; else if (u > maxx) u = maxx;
      if (!(v >= 0)) v = 0; else if (v > maxy) v = maxy;
      const x0 = u | 0, y0 = v | 0;
      const x1 = x0 < maxx ? x0 + 1 : x0, y1 = y0 < maxy ? y0 + 1 : y0;
      const fx = u - x0, fy = v - y0;
      const r0 = y0 * sw, r1 = y1 * sw;
      const i00 = (r0 + x0) * 4, i01 = (r0 + x1) * 4, i10 = (r1 + x0) * 4, i11 = (r1 + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      out[o]     = src[i00]     * w00 + src[i01]     * w01 + src[i10]     * w10 + src[i11]     * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
    }
  }
}

// blanchit le fond : estime le niveau du papier par tuiles, interpole, divise.
// Corrige l'éclairage inégal qu'un étalement global ne peut pas rattraper.
function flattenBackground(d, w, h) {
  const G = Math.max(4, Math.min(32, Math.floor(Math.min(w, h) / 8)));
  const bg = new Float32Array(G * G);
  const hist = new Uint32Array(256);

  for (let ty = 0; ty < G; ty++) {
    const y0 = Math.floor((ty * h) / G), y1 = Math.floor(((ty + 1) * h) / G);
    for (let tx = 0; tx < G; tx++) {
      const x0 = Math.floor((tx * w) / G), x1 = Math.floor(((tx + 1) * w) / G);
      hist.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
          n++;
        }
      }
      let acc = 0, v = 255;
      const target = n * 0.15;
      for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= target) { v = k; break; } }
      bg[ty * G + tx] = v < 64 ? 64 : v;
    }
  }

  const sx = G / w, sy = G / h;
  for (let y = 0; y < h; y++) {
    let fy = y * sy - 0.5, y0 = Math.floor(fy), wy = fy - y0;
    if (y0 < 0) { y0 = 0; wy = 0; }
    if (y0 > G - 2) { y0 = G - 2; wy = 0; }
    const r0 = y0 * G, r1 = r0 + G;
    for (let x = 0; x < w; x++) {
      let fx = x * sx - 0.5, x0 = Math.floor(fx), wx = fx - x0;
      if (x0 < 0) { x0 = 0; wx = 0; }
      if (x0 > G - 2) { x0 = G - 2; wx = 0; }
      const B = (bg[r0 + x0] * (1 - wx) + bg[r0 + x0 + 1] * wx) * (1 - wy)
              + (bg[r1 + x0] * (1 - wx) + bg[r1 + x0 + 1] * wx) * wy;
      const k = 255 / B;
      const i = (y * w + x) * 4;
      d[i] = d[i] * k; d[i + 1] = d[i + 1] * k; d[i + 2] = d[i + 2] * k;
    }
  }
}

// rendu scanner : étalement des niveaux entre p2 et p98, gris (ou gain de blanc en couleur)
function scanLUT(d, n, color) {
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;

  let lo = 0, hi = 255, acc = 0;
  const loT = n * 0.02;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loT) { lo = v; break; } }
  acc = 0;
  const hiT = n * 0.03;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= hiT) { hi = v; break; } }

  const span = hi - lo;
  if (span >= 48) {
    if (!color) {
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) { const o = Math.round(((v - lo) * 255) / span); lut[v] = o < 0 ? 0 : o > 255 ? 255 : o; }
      for (let i = 0, j = 0; j < n; i += 4, j++) {
        const l = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
        d[i] = d[i + 1] = d[i + 2] = l;
      }
    } else {
      const gain = 255 / hi;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i] * gain; d[i + 1] = d[i + 1] * gain; d[i + 2] = d[i + 2] * gain;
      }
    }
  } else if (!color) {
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      d[i] = d[i + 1] = d[i + 2] = l;
    }
  }
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { solve, perspective, sampleBilinear, flattenBackground, scanLUT };
