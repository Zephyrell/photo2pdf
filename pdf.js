/*
 * Minimal PDF writer: one JPEG per page, A4 portrait, no dependencies.
 *   buildPdf([{ bytes: Uint8Array, width, height }]) -> Uint8Array
 * shortcut: JPEG only, no text layer/OCR, no rotation — upgrade if searchable PDFs are needed.
 */
function buildPdf(pages) {
  const A4W = 595.28, A4H = 841.89;
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;

  const put = (u8) => { parts.push(u8); size += u8.length; };
  const text = (s) => put(enc.encode(s));

  text("%PDF-1.4\n");
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  const n = pages.length;
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 3} 0 R`);

  offsets[1] = size;
  text("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  offsets[2] = size;
  text(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    const { bytes, width, height } = pages[i];
    const p = 3 + i * 3;

    const s = Math.min(A4W / width, A4H / height);
    const dw = (width * s).toFixed(2);
    const dh = (height * s).toFixed(2);
    const tx = ((A4W - width * s) / 2).toFixed(2);
    const ty = ((A4H - height * s) / 2).toFixed(2);

    offsets[p] = size;
    text(`${p} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4W} ${A4H}] ` +
         `/Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>\nendobj\n`);

    offsets[p + 1] = size;
    text(`${p + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
         `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    put(bytes);
    text("\nendstream\nendobj\n");

    const content = `q ${dw} 0 0 ${dh} ${tx} ${ty} cm /Im0 Do Q`;
    offsets[p + 2] = size;
    text(`${p + 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  }

  const count = 3 + n * 3; // objects 0..(2 + 3n)
  const xrefAt = size;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let k = 1; k < count; k++) {
    xref += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
  }
  text(xref);
  text(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

if (typeof module !== "undefined" && module.exports) module.exports = { buildPdf };
