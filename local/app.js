import { itemsToText, stripRunningHeaders } from "/pdftext.js";

const $ = (id) => document.getElementById(id);

// ---------- Local storage (IndexedDB, no server, no internet) ----------
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open("audiobook-local", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "id" });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction("books", mode);
    const r = fn(t.objectStore("books"));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}
const allBooks = async () => (await tx("readonly", (s) => s.getAll())).sort((a, b) => b.created_at - a.created_at);
const putBook = (b) => tx("readwrite", (s) => s.put(b));
const delBook = (id) => tx("readwrite", (s) => s.delete(id));
const getBook = (id) => tx("readonly", (s) => s.get(id));
// Save only the small progress fields so we never rewrite the whole file blob.
async function patchBook(id, fields) {
  const b = await getBook(id);
  if (b) await putBook({ ...b, ...fields });
}

// ---------- Views ----------
function show(name) {
  for (const v of ["library", "reader"]) $(v).hidden = v !== name;
}

// ---------- Library ----------
async function loadLibrary() {
  show("library");
  const books = await allBooks();
  const list = $("bookList");
  list.replaceChildren();
  $("empty").hidden = books.length > 0;
  for (const b of books) {
    const li = document.createElement("li");
    li.className = "book";
    const pct = b.total ? Math.round((b.position / b.total) * 100) : 0;
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title"; title.textContent = b.title;
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent = `${(b.size / 1048576).toFixed(1)} MB · ${b.total ? pct + "% read" : "not started"}`;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = pct + "%";
    bar.append(fill);
    info.append(title, meta, bar);
    info.addEventListener("click", () => openBook(b));
    const del = document.createElement("button");
    del.className = "ghost"; del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${b.title}"?`)) return;
      await delBook(b.id);
      loadLibrary();
    });
    li.append(info, del);
    list.append(li);
  }
}

const TYPES = { pdf: "application/pdf", txt: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

$("fileInput").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) {
    const ext = f.name.split(".").pop().toLowerCase();
    if (!TYPES[ext]) { $("status").textContent = `${f.name}: only PDF, DOCX and TXT are supported`; return; }
    $("status").textContent = `Adding ${f.name}…`;
    await putBook({
      id: crypto.randomUUID(), title: f.name.replace(/\.[^.]+$/, ""), filename: f.name,
      content_type: TYPES[ext], size: f.size, position: 0, total: 0, page_start: 0, page_end: 0,
      created_at: Date.now(), blob: new Blob([await f.arrayBuffer()], { type: TYPES[ext] }),
    });
  }
  $("status").textContent = "";
  loadLibrary();
});

// ---------- Text extraction ----------
async function extractText(blob, contentType) {
  if (contentType === "application/pdf") {
    const pdfjs = await import("/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
    const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      $("readerStatus").textContent = `Reading page ${i} of ${pdf.numPages}…`;
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(itemsToText(content.items));
    }
    return stripRunningHeaders(pages);
  }
  if (contentType.startsWith("text/plain")) return [await blob.text()];
  const r = await window.mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return [r.value];
}

// Split into speakable chunks (sentences, capped length).
function chunkText(text) {
  const paras = text.replace(/\r/g, "").split(/\n\s*\n/);
  const out = [];
  for (const p of paras) {
    const flat = p
      .replace(/-\n(?=[a-z])/g, "")
      .replace(/[.…_]{4,}/g, " ") // table-of-contents dot leaders and rules
      .replace(/\s+/g, " ")
      .trim();
    if (!flat) continue;
    const sentences = flat.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [flat];
    let cur = "";
    for (const s of sentences) {
      if ((cur + s).length > 220 && cur) { out.push(cur.trim()); cur = ""; }
      cur += s;
      while (cur.length > 300) {
        let cut = cur.lastIndexOf(" ", 240);
        if (cut < 100) cut = 240;
        out.push(cur.slice(0, cut).trim());
        cur = cur.slice(cut);
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

// ---------- Reader ----------
const R = { book: null, chunks: [], spans: [], pageOf: [], pages: 1, lo: 0, hi: 0, idx: 0, playing: false, gen: 0, saveTimer: 0, wake: null };

async function openBook(book) {
  stop();
  show("reader");
  R.book = book; R.chunks = []; R.spans = []; R.pageOf = []; R.idx = 0; R.lo = 0; R.hi = 0;
  $("rangeRow").hidden = true;
  $("bookTitle").textContent = book.title;
  $("text").replaceChildren();
  $("readerStatus").textContent = "Loading…";
  try {
    const pages = await extractText(book.blob, book.content_type);
    R.pages = pages.length;
    pages.forEach((pageText, p) => {
      for (const c of chunkText(pageText)) { R.chunks.push(c); R.pageOf.push(p + 1); }
    });
  } catch (err) {
    $("readerStatus").textContent = "Could not read this file: " + err.message;
    return;
  }
  if (!R.chunks.length) {
    $("readerStatus").textContent = "No readable text found. This may be a scanned PDF (images only), which needs OCR.";
    return;
  }
  $("readerStatus").textContent = "";
  const frag = document.createDocumentFragment();
  R.chunks.forEach((c, i) => {
    if (R.pages > 1 && R.pageOf[i] !== R.pageOf[i - 1]) {
      const pb = document.createElement("div");
      pb.className = "pagebreak";
      pb.textContent = `PDF page ${R.pageOf[i]}`;
      frag.append(pb);
    }
    const s = document.createElement("span");
    s.textContent = c + " ";
    s.dataset.i = i;
    frag.append(s);
    R.spans.push(s);
  });
  $("text").append(frag);
  $("rangeRow").hidden = R.pages < 2;
  $("pageFrom").max = $("pageTo").max = R.pages;
  $("pageOf").textContent = `of ${R.pages}`;
  $("pageFrom").value = book.page_start || 1;
  $("pageTo").value = book.page_end || R.pages;
  applyRange(false);
  setIndex(book.position || 0, true);
}

// Restrict reading to a page range; chunks outside it are dimmed and skipped.
function applyRange(save) {
  const clamp = (n, d) => Math.min(R.pages, Math.max(1, parseInt(n, 10) || d));
  let from = clamp($("pageFrom").value, 1);
  let to = clamp($("pageTo").value, R.pages);
  if (from > to) [from, to] = [to, from];
  let lo = R.pageOf.findIndex((p) => p >= from);
  let hi = R.pageOf.findLastIndex((p) => p <= to);
  if (lo < 0 || hi < lo) { from = 1; to = R.pages; lo = 0; hi = R.chunks.length - 1; }
  R.lo = lo; R.hi = hi;
  $("pageFrom").value = from; $("pageTo").value = to;
  R.spans.forEach((s, i) => s.classList.toggle("skip", i < lo || i > hi));
  $("seek").min = lo; $("seek").max = hi;
  if (save) {
    const full = from === 1 && to === R.pages;
    R.book.page_start = full ? 0 : from; R.book.page_end = full ? 0 : to;
    patchBook(R.book.id, { page_start: R.book.page_start, page_end: R.book.page_end }).catch(() => {});
  }
}
for (const id of ["pageFrom", "pageTo"]) {
  $(id).addEventListener("change", () => {
    if (!R.chunks.length) return;
    applyRange(true);
    setIndex(R.idx);
    if (R.playing) speak();
  });
}

$("text").addEventListener("click", (e) => {
  const s = e.target.closest("span");
  if (s) { setIndex(Number(s.dataset.i)); if (R.playing) speak(); }
});
$("seek").addEventListener("input", () => { setIndex(Number($("seek").value)); if (R.playing) speak(); });

function setIndex(i, scroll = true) {
  if (!R.spans.length) return;
  R.spans[R.idx]?.classList.remove("cur");
  R.idx = Math.max(R.lo, Math.min(i, R.hi));
  const s = R.spans[R.idx];
  s.classList.add("cur");
  if (scroll) s.scrollIntoView({ block: "center", behavior: "smooth" });
  $("seek").value = R.idx;
  scheduleSave();
}

function scheduleSave(now = false) {
  clearTimeout(R.saveTimer);
  const go = () => {
    if (!R.book || !R.chunks.length) return;
    R.book.position = R.idx; R.book.total = R.chunks.length;
    patchBook(R.book.id, { position: R.idx, total: R.chunks.length }).catch(() => {});
  };
  if (now) go(); else R.saveTimer = setTimeout(go, 2500);
}

function speak() {
  const gen = ++R.gen;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(R.chunks[R.idx]);
  u.rate = Number($("rate").value);
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === $("voice").value);
  if (v) { u.voice = v; u.lang = v.lang; }
  const next = () => {
    if (gen !== R.gen || !R.playing) return;
    if (R.idx >= R.hi) { pause(); return; }
    setIndex(R.idx + 1);
    speak();
  };
  u.onend = next;
  u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
  // Small delay avoids a Chrome bug where speak() right after cancel() is dropped.
  setTimeout(() => { if (gen === R.gen) speechSynthesis.speak(u); }, 30);
}

async function play() {
  if (!R.chunks.length) return;
  R.playing = true;
  $("play").innerHTML = "&#9208;";
  speak();
  try { R.wake = await navigator.wakeLock?.request("screen"); } catch {}
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: R.book.title, artist: "Audiobook Reader" });
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => skip(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => skip(1));
  }
}
function pause() {
  R.playing = false; R.gen++;
  speechSynthesis.cancel();
  $("play").innerHTML = "&#9654;";
  R.wake?.release?.().catch(() => {}); R.wake = null;
  scheduleSave(true);
}
function stop() { if (R.book) pause(); R.book = null; }
function skip(d) { setIndex(R.idx + d); if (R.playing) speak(); }

$("play").addEventListener("click", () => (R.playing ? pause() : play()));
$("prev").addEventListener("click", () => skip(-1));
$("next").addEventListener("click", () => skip(1));
$("rate").addEventListener("change", () => { if (R.playing) speak(); });
$("voice").addEventListener("change", () => { localStorage.setItem("voice", $("voice").value); if (R.playing) speak(); });
$("back").addEventListener("click", () => { stop(); loadLibrary(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && R.book) scheduleSave(true); });

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const saved = localStorage.getItem("voice");
  const sel = $("voice");
  const pref = navigator.language.slice(0, 2);
  sel.replaceChildren();
  // Voices that run on this computer work offline; "online"/Google/Natural ones need internet.
  [...voices]
    .sort((a, b) => (b.localService - a.localService) || (b.lang.startsWith(pref) - a.lang.startsWith(pref)) || a.name.localeCompare(b.name))
    .forEach((v) => {
      const o = document.createElement("option");
      o.value = v.voiceURI; o.textContent = `${v.localService ? "" : "[needs internet] "}${v.name} (${v.lang})`;
      sel.append(o);
    });
  if (saved && voices.some((v) => v.voiceURI === saved)) sel.value = saved;
}
speechSynthesis.addEventListener("voiceschanged", loadVoices);
loadVoices();

// ---------- Boot ----------
loadLibrary();
