// Remove running headers/footers (e.g. "IEC 60204-1:2016 (c) IEC 2016 - 15 -") and bare page
// numbers. A line counts as one if, ignoring digits, it appears at the top or bottom of at
// least 30% of the pages.
export function stripRunningHeaders(pages) {
  if (pages.length < 6) return pages;
  const norm = (l) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const eligible = (l) => /^[–-]?\s*\d+\s*[–-]?$/.test(l) || (l.match(/[A-Za-z]/g) || []).length >= 4;
  const edgeIdx = (lines) => {
    const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    return [...idx.slice(0, 2), ...idx.slice(-2)];
  };
  const split = pages.map((p) => p.split("\n"));
  const counts = new Map();
  for (const lines of split) {
    const seen = new Set();
    for (const i of edgeIdx(lines)) if (eligible(lines[i].trim())) seen.add(norm(lines[i]));
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.3));
  const bad = new Set([...counts].filter(([, n]) => n >= min).map(([k]) => k));
  if (!bad.size) return pages;
  return split.map((lines) => {
    const drop = new Set(edgeIdx(lines).filter((i) => bad.has(norm(lines[i]))));
    return lines.filter((_, i) => !drop.has(i)).join("\n");
  });
}

// Rebuild readable text from pdf.js text items using their positions.
//
// Some PDFs (e.g. standards typeset with per-glyph positioning) store one item per glyph, and
// pdf.js adds whitespace items and stray inner spaces ("f o") that cannot be trusted. For those
// pages we ignore the pdf.js spaces and work out word gaps from real glyph positions. Each
// glyph's normal in-word gap is learned from the page, because narrow letters like "f" and
// digits like "1" report widths that make gaps look bigger or smaller than they are.
export function itemsToText(items) {
  const visible = items.filter((it) => typeof it.str === "string" && it.transform && it.str.trim() !== "");
  if (!visible.length) return "";
  const avgLen = visible.reduce((n, it) => n + it.str.length, 0) / visible.length;
  const perGlyph = avgLen < 2;
  const list = perGlyph ? visible : items.filter((it) => typeof it.str === "string" && it.transform);
  const H = (it) => it.height || Math.hypot(it.transform[0], it.transform[1]) || 10;
  const sameLine = (a, b) => Math.abs(a.transform[5] - b.transform[5]) <= H(b) * 0.5;
  const ratio = (a, b) => (b.transform[4] - (a.transform[4] + (a.width || 0))) / H(b);

  // Learn each glyph's normal in-word gap (10th percentile of its small gaps).
  let baseline = () => 0;
  if (perGlyph) {
    const per = new Map();
    const all = [];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (!sameLine(a, b)) continue;
      const r = ratio(a, b);
      if (r > 0.35 || r < -0.3) continue;
      const k = a.fontName + "|" + a.str;
      (per.get(k) || per.set(k, []).get(k)).push(r);
      all.push(r);
    }
    const pct = (arr, p) => arr.slice().sort((x, y) => x - y)[Math.floor((arr.length - 1) * p)];
    const fallback = all.length ? Math.max(0, pct(all, 0.3)) : 0.05;
    const base = new Map();
    for (const [k, arr] of per) base.set(k, arr.length >= 8 ? Math.min(0.25, Math.max(0, pct(arr, 0.1))) : fallback);
    baseline = (a) => base.get(a.fontName + "|" + a.str) ?? fallback;
  }

  const lastCh = (s) => s.str.trim().slice(-1);
  const firstCh = (s) => s.str.trim().charAt(0);
  const needSpace = (a, b) => {
    const r = ratio(a, b);
    if (!perGlyph) return r > 0.15;
    const p = lastCh(a), n = firstCh(b);
    if (/\d/.test(p) && /\d/.test(n)) return r > 0.3; // digits inside a number
    if (/[,.;:)\]%°]/.test(n)) return r > 0.3; // closing punctuation attaches
    if (/[,;]/.test(p) && /[\p{L}\d(]/u.test(n)) return r > 0.08; // space after comma/semicolon
    return r - baseline(a) > 0.12;
  };

  let out = "";
  let prev = null;
  for (const it of list) {
    const fs = H(it);
    if (prev) {
      const dy = prev.transform[5] - it.transform[5]; // positive when moving down the page
      if (Math.abs(dy) > fs * 0.5) out += dy > fs * 1.9 ? "\n\n" : "\n";
      else if (needSpace(prev, it)) out += " ";
    }
    // In per-glyph PDFs a space inside an item (e.g. "f o") is an artifact.
    out += perGlyph ? it.str.replace(/\s+/g, "") : it.str;
    prev = it;
  }
  return out.replace(/\b([A-Z])\. (\d)/g, "$1.$2"); // "Table D. 3" -> "Table D.3"
}
