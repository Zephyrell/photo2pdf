const assert = require("node:assert");
const { perspective, sampleBilinear, flattenBackground, scanLUT, findDocCorners } = require("./core.js");

const R = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

// 5x5 source : rouge = 10x + y + 1
function src5() {
  const d = new Uint8ClampedArray(5 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const i = (y * 5 + x) * 4;
    d[i] = 10 * x + y + 1; d[i + 3] = 255;
  }
  return d;
}
const px = (d, w, x, y) => d[(y * w + x) * 4];

// 1. identité : la sortie reproduit exactement la source
{
  const src = src5(), out = new Uint8ClampedArray(5 * 5 * 4);
  const M = perspective(R(4, 4), R(4, 4));
  sampleBilinear(src, 5, 5, M, out, 5, 5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++)
    assert.strictEqual(px(out, 5, x, y), 10 * x + y + 1, `identité @ ${x},${y}`);
}

// 2. translation de +1 en x
{
  const src = src5(), out = new Uint8ClampedArray(5 * 5 * 4);
  const M = perspective(R(5, 5), [[1, 0], [6, 0], [6, 5], [1, 5]]);
  sampleBilinear(src, 5, 5, M, out, 5, 5);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++)
    assert.strictEqual(px(out, 5, x, y), 10 * (x + 1) + y + 1, `translation @ ${x},${y}`);
}

// 3. agrandissement ×2, mêmes pixels aux coordonnées paires
{
  const src = src5(), out = new Uint8ClampedArray(8 * 8 * 4);
  const M = perspective(R(8, 8), R(4, 4));
  sampleBilinear(src, 5, 5, M, out, 8, 8);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    assert.strictEqual(px(out, 8, 2 * x, 2 * y), 10 * x + y + 1, `scale @ ${x},${y}`);
}

// 4. rendu gris : 90 % papier à 200, 10 % texte à 50 -> 255 / 0
function sheet(base, text) {
  const d = new Uint8ClampedArray(100 * 4);
  for (let k = 0; k < 100; k++) {
    const v = k < 10 ? text : base;
    d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = v; d[k * 4 + 3] = 255;
  }
  return d;
}
{
  const d = sheet(200, 50);
  scanLUT(d, 100, false);
  assert.strictEqual(d[0], 0, "texte -> 0");
  assert.strictEqual(d[99 * 4], 255, "papier -> 255");
  for (let k = 0; k < 100; k++)
    assert.ok(d[k * 4] === d[k * 4 + 1] && d[k * 4 + 1] === d[k * 4 + 2], "r=g=b");
}

// 5. couleur : gain de blanc, pas de changement de teinte
{
  const d = sheet(200, 50);
  d[0] = 50; d[1] = 100; d[2] = 150; // un pixel coloré à la place du "texte"
  scanLUT(d, 100, true);
  assert.strictEqual(d[0], 64, "50 * 255/200 -> 64");
  assert.strictEqual(d[1], 127, "100 * 255/200 -> 127 (arrondi flottant)");
  assert.strictEqual(d[2], 191, "150 * 255/200 -> 191");
  assert.strictEqual(d[99 * 4], 255, "papier -> 255");
}

// 6. éclairage inégal : papier de 100 à 220, texte à 45 % -> papier blanc partout
{
  const w = 256, h = 256;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = 100 + (120 * x) / (w - 1);
    const v = Math.round(y % 4 === 0 ? paper * 0.45 : paper);
    const i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  flattenBackground(d, w, h);
  let minPaper = 255, maxText = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = d[(y * w + x) * 4];
    if (y % 4 === 0) maxText = Math.max(maxText, v);
    else minPaper = Math.min(minPaper, v);
  }
  assert.ok(minPaper >= 248, `papier uniformément blanc (min ${minPaper})`);
  assert.ok(maxText >= 100 && maxText <= 125, `texte conservé (max ${maxText})`);
}

// ---------- détection des coins ----------
const noise = (x, y, a) => (((x * 73856093) ^ (y * 19349663)) % (2 * a + 1)) - a;

function synth(w, h, bg, quad, paper, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  const inside = (x, y) => {
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = quad[i], [x1, y1] = quad[(i + 1) % 4];
      if ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) < 0) return false;
    }
    return true;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inq = inside(x, y), v = inq ? paper : bg;
    const [r, g, b] = paint ? paint(x, y, inq) : [v, v, v];
    d[i] = r + noise(x, y, 4); d[i + 1] = g + noise(x, y, 4);
    d[i + 2] = b + noise(x, y, 4); d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
const near = (q, want, tol, label) => {
  assert.ok(q, `${label} : aucun quadrilatère`);
  q.forEach(([x, y], i) =>
    assert.ok(Math.abs(x - want[i][0]) <= tol && Math.abs(y - want[i][1]) <= tol,
      `${label} : coin ${i} à ${x},${y}, attendu ${want[i][0]},${want[i][1]}`));
};

// 7. document incliné sur un fond sombre
{
  const q = [[50, 30], [190, 55], [165, 150], [35, 125]];
  near(findDocCorners(synth(220, 180, 60, q, 235)), q, 3, "doc incliné");
}
// 8. feuille droite sur un bureau gris
{
  const q = [[30, 25], [190, 25], [190, 155], [30, 155]];
  near(findDocCorners(synth(220, 180, 90, q, 225)), q, 3, "feuille droite");
}
// 9. document sombre sur fond clair (polarité inverse)
{
  const q = [[40, 30], [180, 40], [170, 150], [30, 140]];
  near(findDocCorners(synth(220, 180, 220, q, 40)), q, 3, "doc sombre");
}
// 10. rien à détecter : image uniforme, et tache trop petite
{
  assert.strictEqual(findDocCorners(synth(200, 160, 120, [[0, 0], [0, 0], [0, 0], [0, 0]], 120)), null, "uniforme");
  const q = [[92, 72], [108, 72], [108, 88], [92, 88]];
  assert.strictEqual(findDocCorners(synth(200, 160, 60, q, 235)), null, "tache de 2 %");
}

// 11. document qui dépasse du cadre : les coins visibles sont sur le bord
{
  const q = [[60, -40], [340, -40], [340, 220], [60, 220]];
  near(findDocCorners(synth(400, 300, 60, q, 235)), [[60, 0], [340, 0], [340, 220], [60, 220]], 3, "doc à cheval sur le bord");
}
// 12. ombre large et douce sous le document (transition de 8 px)
{
  const w = 400, h = 300, q = [[70, 40], [330, 40], [330, 260], [70, 260]];
  const d = new Uint8ClampedArray(w * h * 4);
  const inside = (x, y) => x >= q[0][0] && x <= q[1][0] && y >= q[0][1] && y <= q[3][1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let v;
    if (inside(x, y)) v = 235;
    else {
      const dx = Math.max(q[0][0] - x, x - q[1][0], 0), dy = Math.max(q[0][1] - y, y - q[3][1], 0);
      const dmin = Math.max(dx, dy);
      v = dmin < 8 ? 235 - (dmin / 8) * 115 : 120;
    }
    v += noise(x, y, 3);
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  near(findDocCorners({ data: d, width: w, height: h }), q, 6, "ombre douce");
}

// 13. lumière oblique sur un bureau chaud : le bas du papier descend à la luminance
//     du bois, seule la teinte (r-b) les sépare — sans elle, la propagation débordait
{
  const q = [[30, 56], [255, 48], [285, 381], [28, 394]];
  const img = synth(300, 400, 0, q, 0, (x, y, inq) => {
    if (!inq) return [188, 132, 78];             // bureau bois, luminance ≈ 142
    const p = 225 - 75 * x / 300;                // papier : dégradé 225 → 150
    return [p, p - 1, p - 8];                    // neutre, très légèrement chaud
  });
  near(findDocCorners(img), q, 4, "papier oblique sur bureau chaud");
}
console.log("core : 13 tests OK  — homographie, échantillonnage, fond local, rendu gris, rendu couleur, coins");
