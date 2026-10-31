const assert = require("node:assert");
const fs = require("node:fs");
const { buildPdf } = require("./pdf.js");

// 1x1 white baseline JPEG, enough to prove the structure parses
const jpg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

const N = 3;
const bytes = buildPdf(Array.from({ length: N }, () => ({ bytes: new Uint8Array(jpg), width: 1, height: 1 })));
const s = Buffer.from(bytes).toString("latin1");

assert.ok(s.startsWith("%PDF-1.4"), "header");
assert.ok(s.trimEnd().endsWith("%%EOF"), "eof");
assert.ok(s.includes(`/Count ${N}`), "page count");

const m = s.match(/startxref\n(\d+)\n/);
assert.ok(m, "startxref");
const xrefAt = Number(m[1]);
assert.strictEqual(s.slice(xrefAt, xrefAt + 4), "xref", "startxref -> xref");

const count = 3 + N * 3;
const entriesAt = xrefAt + `xref\n0 ${count}\n`.length;
for (let k = 1; k < count; k++) {
  const entry = s.slice(entriesAt + k * 20, entriesAt + (k + 1) * 20);
  assert.strictEqual(entry.length, 20, `entry ${k} width`);
  const off = Number(entry.slice(0, 10));
  assert.ok(s.startsWith(`${k} 0 obj`, off), `object ${k} @ ${off}`);
}

fs.writeFileSync("/tmp/scan-test.pdf", bytes);
console.log(`ok — ${bytes.length} bytes, ${N} pages, ${count} objects`);
