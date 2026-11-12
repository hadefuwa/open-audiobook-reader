import { itemsToText, stripRunningHeaders } from "/pdftext.js";

const $ = (id) => document.getElementById(id);
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168";
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  if (res.status === 401 && path !== "/api/login") { show("login"); throw new Error("Unauthorized"); }
  return res;
}
const getJSON = async (p) => (await api(p)).json();
const putJSON = (p, body, extra = {}) =>
  fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...extra }).catch(() => {});

let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- Preferences & theme ----------
const prefs = {
  theme: store.get("theme", "auto"),
  font: store.get("font", "sans"),
  size: Number(store.get("size", "18")),
  follow: store.get("follow", "1") === "1",
  hideSkipped: store.get("hideSkipped", "0") === "1",
  rate: Number(store.get("rate", "1")),
};
function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") root.removeAttribute("data-theme"); else root.dataset.theme = prefs.theme;
  root.dataset.font = prefs.font;
  root.style.setProperty("--read-size", prefs.size + "px");
  requestAnimationFrame(() => {
    $("themeColor").content = getComputedStyle(document.body).backgroundColor;
  });
  for (const seg of ["themeSeg", "themeSeg2"]) markSeg($(seg), prefs.theme);
  markSeg($("fontSeg"), prefs.font);
  $("fontSize").value = prefs.size; $("sizeVal").textContent = prefs.size + "px";
  $("follow").checked = prefs.follow; $("dimSkipped").checked = prefs.hideSkipped;
  $("text").classList.toggle("hide-skipped", prefs.hideSkipped);
}
const markSeg = (seg, v) => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
function bindSeg(id, key) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    prefs[key] = b.dataset.v; store.set(key, prefs[key]); applyTheme();
  });
}
bindSeg("themeSeg", "theme"); bindSeg("themeSeg2", "theme"); bindSeg("fontSeg", "font");
$("fontSize").addEventListener("input", () => { prefs.size = Number($("fontSize").value); store.set("size", prefs.size); applyTheme(); });
$("follow").addEventListener("change", () => { prefs.follow = $("follow").checked; store.set("follow", prefs.follow ? "1" : "0"); });
$("dimSkipped").addEventListener("change", () => { prefs.hideSkipped = $("dimSkipped").checked; store.set("hideSkipped", prefs.hideSkipped ? "1" : "0"); applyTheme(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

// ---------- Views & sheets ----------
function show(name) {
  for (const v of ["login", "library", "reader"]) $(v).hidden = v !== name;
  window.scrollTo(0, 0);
}
let sheetOpener = null;
function openSheet(name, title) {
  sheetOpener = document.activeElement;
  document.querySelectorAll("[data-sheet]").forEach((s) => (s.hidden = s.dataset.sheet !== name));
  $("sheetTitle").textContent = title;
  $("sheet").hidden = false;
  $("sheetClose").focus();
}
function closeSheet() { $("sheet").hidden = true; sheetOpener?.focus?.(); }
$("scrim").addEventListener("click", closeSheet);
$("sheetClose").addEventListener("click", closeSheet);

// ---------- Login ----------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  const res = await api("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: $("password").value }),
  });
  if (res.ok) { $("password").value = ""; loadLibrary(); }
  else $("loginError").textContent = (await res.json()).error || "Login failed";
});
$("logout").addEventListener("click", async () => { closeSheet(); await api("/api/logout", { method: "POST" }); show("login"); });
$("appMenu").addEventListener("click", () => openSheet("app", "Settings"));

// ---------- Library ----------
let books = [];
let menuBook = null;
const HUES = [[221, 262], [14, 340], [160, 200], [32, 8], [280, 320], [190, 230], [95, 150], [345, 20]];
function hashStr(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function gradient(title) {
  const [a, b] = HUES[hashStr(title) % HUES.length];
  return `linear-gradient(135deg, hsl(${a} 70% 52%), hsl(${b} 70% 44%))`;
}
const pctOf = (b) => (b.total ? Math.min(100, Math.round((b.position / b.total) * 100)) : 0);
const typeOf = (b) => (b.filename.split(".").pop() || "").toUpperCase();

async function loadLibrary() {
  show("library");
  try { books = await getJSON("/api/books"); } catch { return; }
  renderLibrary();
}

function renderLibrary() {
  const q = $("search").value.trim().toLowerCase();
  const sort = $("sort").value;
  const list = books.filter((b) => !q || b.title.toLowerCase().includes(q));
  list.sort((a, b) =>
    sort === "title" ? a.title.localeCompare(b.title)
    : sort === "progress" ? pctOf(b) - pctOf(a)
    : sort === "added" ? b.created_at.localeCompare(a.created_at)
    : b.updated_at.localeCompare(a.updated_at));

  $("empty").hidden = books.length > 0;
  $("noMatch").hidden = !(books.length && !list.length);
  document.querySelector(".toolbar").hidden = !books.length;

  // "Continue listening" = most recently read book that has progress and isn't finished.
  const recent = [...books].filter((b) => b.total && pctOf(b) < 100).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const cont = $("continue");
  cont.hidden = !recent || !!q;
  if (recent && !q) {
    cont.style.background = gradient(recent.title);
    cont.innerHTML = `<div class="ctext"><div class="k">Continue listening</div><div class="t"></div><div class="bar"><i></i></div></div><div class="go"><svg class="ic"><use href="#i-play"/></svg></div>`;
    cont.querySelector(".t").textContent = recent.title;
    cont.querySelector("i").style.width = pctOf(recent) + "%";
    cont.onclick = () => openBook(recent);
  }

  const ul = $("bookList");
  ul.replaceChildren();
  for (const b of list) {
    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `<div class="cover"><span class="badge"></span><span class="ct"></span><button class="icon-btn menu" aria-label="Book options"><svg class="ic"><use href="#i-more"/></svg></button></div>
      <div class="meta"><div class="name"></div><div class="sub"></div><div class="bar"><i></i></div></div>`;
    li.querySelector(".cover").style.background = gradient(b.title);
    li.querySelector(".badge").textContent = typeOf(b);
    li.querySelector(".ct").textContent = b.title;
    li.querySelector(".name").textContent = b.title;
    li.querySelector(".sub").textContent = `${(b.size / 1048576).toFixed(1)} MB · ${b.total ? pctOf(b) + "% read" : "Not started"}`;
    li.querySelector("i").style.width = pctOf(b) + "%";
    li.addEventListener("click", () => openBook(b));
    li.querySelector(".menu").addEventListener("click", (e) => { e.stopPropagation(); menuBook = b; openSheet("bookmenu", b.title); });
    ul.append(li);
  }
}
$("search").addEventListener("input", renderLibrary);
$("sort").value = store.get("sort", "recent");
$("sort").addEventListener("change", () => { store.set("sort", $("sort").value); renderLibrary(); });

$("bmRename").addEventListener("click", async () => {
  const b = menuBook; closeSheet();
  const t = prompt("Rename book", b.title);
  if (t == null || !t.trim()) return;
  const res = await api(`/api/books/${b.id}/meta`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t }) });
  if (res.ok) { b.title = t.trim(); renderLibrary(); toast("Renamed"); } else toast("Could not rename");
});
$("bmDelete").addEventListener("click", async () => {
  const b = menuBook; closeSheet();
  if (!confirm(`Delete "${b.title}"? This cannot be undone.`)) return;
  await api(`/api/books/${b.id}`, { method: "DELETE" });
  toast("Deleted"); loadLibrary();
});

// Upload with progress (XHR gives upload progress events; fetch does not).
function uploadOne(file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/books?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 401) { show("login"); return resolve({ ok: false, error: "Signed out" }); }
      let msg = ""; try { msg = JSON.parse(xhr.responseText).error || ""; } catch {}
      resolve({ ok: xhr.status < 300, error: msg || `Upload failed (${xhr.status})` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Network error" });
    xhr.send(file);
  });
}
async function uploadFiles(files) {
  files = [...files].filter((f) => /\.(pdf|docx|txt)$/i.test(f.name));
  if (!files.length) { toast("Only PDF, DOCX and TXT files are supported"); return; }
  $("progressBox").hidden = false;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const label = `Uploading ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ""}…`;
    $("status").textContent = label; $("uploadFill").style.width = "0%";
    const r = await uploadOne(f, (p) => ($("uploadFill").style.width = Math.round(p * 100) + "%"));
    if (!r.ok) { failed++; toast(`${f.name}: ${r.error}`); }
  }
  $("progressBox").hidden = true;
  if (!failed) toast(files.length > 1 ? `${files.length} books added` : "Book added");
  loadLibrary();
}
$("fileInput").addEventListener("change", (e) => { const f = e.target.files; uploadFiles(f).finally(() => (e.target.value = "")); });
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (!$("library").hidden && e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("dropHint").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropHint").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("dropHint").hidden = true; if (!$("library").hidden) uploadFiles(e.dataTransfer.files); });

// ---------- Text extraction ----------
async function extractText(blob, contentType) {
  if (contentType === "application/pdf") {
    const pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
    if (!extractText.worker) {
      const src = await (await fetch(`${PDFJS}/pdf.worker.min.mjs`)).text();
      extractText.worker = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    }
    pdfjs.GlobalWorkerOptions.workerSrc = extractText.worker;
    const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      setStatus(`Reading page ${i} of ${pdf.numPages}…`);
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(itemsToText(content.items));
    }
    return { pages: stripRunningHeaders(pages), outline: await readOutline(pdf) };
  }
  if (contentType.startsWith("text/plain")) return { pages: [await blob.text()], outline: [] };
  const r = await window.mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return { pages: [r.value], outline: [] };
}

// PDF bookmarks -> flat list of { title, page, depth }.
async function readOutline(pdf) {
  try {
    const out = [];
    const walk = async (items, depth) => {
      for (const it of items) {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          const page = typeof dest[0] === "object" ? (await pdf.getPageIndex(dest[0])) + 1 : dest[0] + 1;
          out.push({ title: it.title.trim(), page, depth });
        }
        if (it.items?.length && depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk((await pdf.getOutline()) || [], 0);
    return out.filter((o) => o.title);
  } catch { return []; }
}

function setStatus(msg) {
  const el = $("readerStatus");
  el.textContent = msg || ""; el.hidden = !msg;
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
const R = {
  book: null, chunks: [], spans: [], pageOf: [], ok: [], pages: 1, lo: 0, hi: 0, idx: 0,
  outline: [], marks: [], playing: false, gen: 0, saveTimer: 0, wake: null, loadToken: 0,
};

// "56, 60-62" -> Set of page numbers.
function parseSkip(str) {
  const set = new Set();
  for (const part of String(str || "").split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= Math.min(b, 5000); p++) set.add(p);
  }
  return set;
}

async function openBook(book) {
  stop();
  const token = ++R.loadToken;
  show("reader");
  Object.assign(R, { book, chunks: [], spans: [], pageOf: [], ok: [], idx: 0, lo: 0, hi: 0, outline: [], marks: [] });
  try { R.marks = JSON.parse(book.bookmarks || "[]"); } catch { R.marks = []; }
  $("bookTitle").textContent = book.title;
  $("bookSub").textContent = "";
  $("btnContents").hidden = true;
  $("text").replaceChildren();
  $("seek").value = 0; $("tCur").textContent = ""; $("tLeft").textContent = "";
  setStatus("Loading…");
  setPlayIcon(false);
  updateRateUI();
  try {
    const res = await api(`/api/books/${book.id}/file`);
    const { pages, outline } = await extractText(await res.blob(), book.content_type);
    if (token !== R.loadToken) return;
    R.pages = pages.length; R.outline = outline;
    pages.forEach((pageText, p) => {
      for (const c of chunkText(pageText)) { R.chunks.push(c); R.pageOf.push(p + 1); }
    });
  } catch (err) {
    if (token === R.loadToken) setStatus("Could not read this file: " + err.message);
    return;
  }
  if (!R.chunks.length) {
    setStatus("No readable text found. This may be a scanned PDF (images only), which needs OCR.");
    return;
  }
  setStatus("");
  const frag = document.createDocumentFragment();
  R.chunks.forEach((c, i) => {
    if (R.pages > 1 && R.pageOf[i] !== R.pageOf[i - 1]) {
      const pb = document.createElement("div");
      pb.className = "pagebreak"; pb.dataset.page = R.pageOf[i];
      pb.textContent = `Page ${R.pageOf[i]}`;
      frag.append(pb);
    }
    const s = document.createElement("span");
    s.textContent = c + " ";
    s.dataset.i = i;
    frag.append(s);
    R.spans.push(s);
  });
  $("text").append(frag);
  $("btnContents").hidden = !R.outline.length;
  $("pageFrom").max = $("pageTo").max = R.pages;
  $("pageOf").textContent = R.pages > 1 ? `of ${R.pages}` : "";
  $("pageFrom").value = book.page_start || 1;
  $("pageTo").value = book.page_end || R.pages;
  $("skipPages").value = book.skip_pages || "";
  $("rangeGroup").hidden = R.pages < 2;
  applyRange(false);
  setIndex(book.position || 0, true, "auto");
}

// Work out which chunks are readable: inside the page range and not in the skip list.
function applyRange(save) {
  const clamp = (n, d) => Math.min(R.pages, Math.max(1, parseInt(n, 10) || d));
  let from = clamp($("pageFrom").value, 1);
  let to = clamp($("pageTo").value, R.pages);
  if (from > to) [from, to] = [to, from];
  const skip = parseSkip($("skipPages").value);
  R.ok = R.pageOf.map((p) => p >= from && p <= to && !skip.has(p));
  if (!R.ok.some(Boolean)) { // everything excluded: fall back to reading all
    from = 1; to = R.pages; skip.clear(); $("skipPages").value = "";
    R.ok = R.pageOf.map(() => true);
    if (save) toast("That would skip everything, so I reset it");
  }
  R.lo = R.ok.indexOf(true); R.hi = R.ok.lastIndexOf(true);
  $("pageFrom").value = from; $("pageTo").value = to;
  R.spans.forEach((s, i) => s.classList.toggle("skip", !R.ok[i]));
  document.querySelectorAll(".pagebreak").forEach((pb) => {
    const p = +pb.dataset.page;
    pb.classList.toggle("skip", !(p >= from && p <= to) || skip.has(p));
  });
  $("seek").min = R.lo; $("seek").max = R.hi;
  const full = from === 1 && to === R.pages;
  R.book.page_start = full ? 0 : from; R.book.page_end = full ? 0 : to;
  R.book.skip_pages = $("skipPages").value.trim();
  if (save) {
    putJSON(`/api/books/${R.book.id}/range`, { page_start: R.book.page_start, page_end: R.book.page_end });
    putJSON(`/api/books/${R.book.id}/meta`, { skip_pages: R.book.skip_pages });
  }
  updateProgressUI();
}
for (const id of ["pageFrom", "pageTo", "skipPages"]) {
  $(id).addEventListener("change", () => {
    if (!R.chunks.length) return;
    applyRange(true);
    setIndex(R.idx, true);
    if (R.playing) speak();
  });
}

// Move to the nearest readable chunk at or after i (direction d = 1) or at or before it (d = -1).
function nearestOk(i, d = 1) {
  i = Math.max(R.lo, Math.min(i, R.hi));
  while (i >= R.lo && i <= R.hi && !R.ok[i]) i += d;
  if (i < R.lo || i > R.hi) { i = Math.max(R.lo, Math.min(i, R.hi)); while (i >= R.lo && i <= R.hi && !R.ok[i]) i -= d; }
  return Math.max(R.lo, Math.min(i, R.hi));
}

$("text").addEventListener("click", (e) => {
  const s = e.target.closest("span");
  if (s) { setIndex(Number(s.dataset.i), false); if (R.playing) speak(); }
});
$("seek").addEventListener("input", () => { setIndex(Number($("seek").value), false); if (R.playing) speak(); });

function setIndex(i, scroll = true, behavior = "smooth", dir = 1) {
  if (!R.spans.length) return;
  R.spans[R.idx]?.classList.remove("cur");
  R.idx = nearestOk(i, dir);
  const s = R.spans[R.idx];
  s.classList.add("cur");
  if (scroll && (prefs.follow || behavior === "auto")) s.scrollIntoView({ block: "center", behavior });
  $("seek").value = R.idx;
  updateProgressUI();
  scheduleSave();
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "";
  const m = Math.round(sec / 60);
  if (m < 1) return "<1 min left";
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m} min left`;
}
function updateProgressUI() {
  if (!R.chunks.length) return;
  let done = 0, left = 0;
  for (let i = R.lo; i <= R.hi; i++) if (R.ok[i]) { if (i < R.idx) done += R.chunks[i].length; else left += R.chunks[i].length; }
  const total = done + left || 1;
  $("tCur").textContent = Math.round((done / total) * 100) + "%";
  // About 15 characters per second at 1x speech.
  $("tLeft").textContent = fmtTime(left / (15 * prefs.rate));
  const pg = R.pageOf[R.idx];
  $("bookSub").textContent = R.pages > 1 ? `Page ${pg} of ${R.pages}` : "";
}

function scheduleSave(now = false) {
  clearTimeout(R.saveTimer);
  const go = () => {
    if (!R.book || !R.chunks.length) return;
    R.book.position = R.idx; R.book.total = R.chunks.length;
    putJSON(`/api/books/${R.book.id}/position`, { position: R.idx, total: R.chunks.length }, { keepalive: true });
  };
  if (now) go(); else R.saveTimer = setTimeout(go, 2500);
}

// ---------- Speech ----------
function speak() {
  const gen = ++R.gen;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(R.chunks[R.idx]);
  u.rate = prefs.rate;
  const v = speechSynthesis.getVoices().find((x) => x.voiceURI === $("voice").value);
  if (v) { u.voice = v; u.lang = v.lang; }
  const next = () => {
    if (gen !== R.gen || !R.playing) return;
    if (sleep.endOfPage && R.pageOf[R.idx + 1] !== R.pageOf[R.idx] && R.idx >= sleep.endOfPage) { clearSleep(); pause(); toast("Sleep timer: stopped at end of page"); return; }
    if (R.idx >= R.hi) { pause(); return; }
    setIndex(R.idx + 1);
    speak();
  };
  u.onend = next;
  u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
  // Small delay avoids a Chrome bug where speak() right after cancel() is dropped.
  setTimeout(() => { if (gen === R.gen) speechSynthesis.speak(u); }, 30);
}

const setPlayIcon = (playing) => {
  $("play").innerHTML = `<svg class="ic"><use href="#i-${playing ? "pause" : "play"}"/></svg>`;
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
};
async function play() {
  if (!R.chunks.length) return;
  R.playing = true;
  setPlayIcon(true);
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
  setPlayIcon(false);
  R.wake?.release?.().catch(() => {}); R.wake = null;
  scheduleSave(true);
}
function stop() { if (R.book) pause(); clearSleep(); R.book = null; }
function skip(d) { setIndex(R.idx + d, true, "smooth", d); if (R.playing) speak(); }
function skipPage(d) {
  if (!R.chunks.length) return;
  const cur = R.pageOf[R.idx];
  let i = R.idx;
  if (d > 0) { while (i < R.hi && (R.pageOf[i] === cur || !R.ok[i])) i++; }
  else {
    while (i > R.lo && R.pageOf[i] === cur) i--;             // into the previous page
    const prevPage = R.pageOf[i];
    while (i > R.lo && R.pageOf[i - 1] === prevPage) i--;    // to its start
  }
  setIndex(i, true, "smooth", d); if (R.playing) speak();
}

$("play").addEventListener("click", () => (R.playing ? pause() : play()));
$("prev").addEventListener("click", () => skip(-1));
$("next").addEventListener("click", () => skip(1));
$("pgPrev").addEventListener("click", () => skipPage(-1));
$("pgNext").addEventListener("click", () => skipPage(1));
$("back").addEventListener("click", () => { stop(); loadLibrary(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && R.book) scheduleSave(true); });
addEventListener("pagehide", () => { if (R.book) scheduleSave(true); });

// ---------- Speed ----------
function setRate(r) {
  prefs.rate = Math.min(3, Math.max(0.5, Math.round(r * 20) / 20));
  store.set("rate", prefs.rate);
  updateRateUI();
  if (R.playing) speak();
}
function updateRateUI() {
  $("rate").value = prefs.rate;
  $("rateVal").textContent = prefs.rate.toFixed(2).replace(/0$/, "") + "×";
  $("btnRate").textContent = prefs.rate.toFixed(2).replace(/\.?0+$/, "") + "×";
  updateProgressUI();
}
$("rate").addEventListener("input", () => setRate(Number($("rate").value)));
$("btnRate").addEventListener("click", () => {
  const sc = $("speedChips"); sc.replaceChildren();
  for (const r of [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const b = document.createElement("button");
    b.className = "chip" + (r === prefs.rate ? " on" : ""); b.textContent = r + "×";
    b.onclick = () => { setRate(r); closeSheet(); };
    sc.append(b);
  }
  openSheet("speed", "Playback speed");
});

// ---------- Sleep timer ----------
const sleep = { timer: 0, until: 0, tick: 0, endOfPage: 0 };
function clearSleep() {
  clearTimeout(sleep.timer); clearInterval(sleep.tick);
  sleep.timer = 0; sleep.until = 0; sleep.endOfPage = 0;
  $("sleepLabel").textContent = "Sleep"; $("btnSleep").classList.remove("on");
}
function setSleep(minutes) {
  clearSleep();
  if (!minutes) return;
  if (minutes === "page") {
    sleep.endOfPage = R.idx; $("sleepLabel").textContent = "End of page"; $("btnSleep").classList.add("on");
    return;
  }
  sleep.until = Date.now() + minutes * 60000;
  const upd = () => { $("sleepLabel").textContent = Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000)) + " min"; };
  upd(); sleep.tick = setInterval(upd, 15000);
  sleep.timer = setTimeout(() => { clearSleep(); pause(); toast("Sleep timer: paused"); }, minutes * 60000);
  $("btnSleep").classList.add("on");
}
$("btnSleep").addEventListener("click", () => {
  const ul = $("sleepList"); ul.replaceChildren();
  const opts = [["Off", 0], ["10 minutes", 10], ["20 minutes", 20], ["30 minutes", 30], ["45 minutes", 45], ["1 hour", 60], ["End of this page", "page"]];
  for (const [label, v] of opts) {
    const li = document.createElement("li"); li.textContent = label;
    li.onclick = () => { setSleep(v); closeSheet(); if (v) toast(`Sleep timer set: ${label.toLowerCase()}`); };
    ul.append(li);
  }
  openSheet("sleep", "Sleep timer");
});

// ---------- Contents & bookmarks ----------
$("btnContents").addEventListener("click", () => {
  const ul = $("contentsList"); ul.replaceChildren();
  const cur = R.pageOf[R.idx];
  R.outline.forEach((o, n) => {
    const li = document.createElement("li");
    li.style.paddingLeft = 14 + o.depth * 16 + "px";
    const next = R.outline[n + 1];
    li.classList.toggle("on", cur >= o.page && (!next || cur < next.page));
    li.innerHTML = `<div class="rt"><b></b></div><span class="muted small tnum">p. ${o.page}</span>`;
    li.querySelector("b").textContent = o.title;
    li.onclick = () => { closeSheet(); goToPage(o.page); };
    ul.append(li);
  });
  openSheet("contents", "Contents");
});
function goToPage(page) {
  const i = R.pageOf.findIndex((p) => p >= page);
  if (i < 0) return;
  if (!R.ok[i]) toast("That section is outside your page range or skipped");
  setIndex(i, true, "smooth");
  if (R.playing) speak();
}

function saveMarks() { putJSON(`/api/books/${R.book.id}/meta`, { bookmarks: R.marks }); R.book.bookmarks = JSON.stringify(R.marks); }
function addMark() {
  if (!R.chunks.length) return;
  if (R.marks.some((m) => m.i === R.idx)) { toast("Already bookmarked"); return; }
  R.marks.push({ i: R.idx, note: R.chunks[R.idx].slice(0, 100), at: Date.now() });
  R.marks.sort((a, b) => a.i - b.i);
  saveMarks(); toast("Bookmarked");
}
function renderMarks() {
  const ul = $("marksList"); ul.replaceChildren();
  $("noMarks").hidden = R.marks.length > 0;
  for (const m of R.marks) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="rt"><b></b><span class="muted small"></span></div><button class="icon-btn x" aria-label="Remove bookmark"><svg class="ic sm"><use href="#i-close"/></svg></button>`;
    li.querySelector("b").textContent = m.note;
    li.querySelector("span").textContent = R.pages > 1 ? `Page ${R.pageOf[m.i] ?? "?"}` : "";
    li.onclick = () => { closeSheet(); setIndex(m.i, true, "smooth"); if (R.playing) speak(); };
    li.querySelector("button").onclick = (e) => { e.stopPropagation(); R.marks = R.marks.filter((x) => x !== m); saveMarks(); renderMarks(); };
    ul.append(li);
  }
}
$("btnMarks").addEventListener("click", () => { renderMarks(); openSheet("marks", "Bookmarks"); });
$("addMark").addEventListener("click", () => { addMark(); renderMarks(); });
$("btnSettings").addEventListener("click", () => openSheet("settings", "Reader settings"));

// ---------- Keyboard ----------
addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$("sheet").hidden) { if (e.key === "Escape") closeSheet(); return; }
  if ($("reader").hidden) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); R.playing ? pause() : play(); }
  else if (k === "ArrowRight") { e.preventDefault(); skip(1); }
  else if (k === "ArrowLeft") { e.preventDefault(); skip(-1); }
  else if (k === "]") skipPage(1);
  else if (k === "[") skipPage(-1);
  else if (k === "b" || k === "B") addMark();
});

// ---------- Voices ----------
function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const saved = store.get("voice", "");
  const sel = $("voice");
  const pref = navigator.language.slice(0, 2);
  sel.replaceChildren();
  [...voices]
    .sort((a, b) => (b.lang.startsWith(pref) - a.lang.startsWith(pref)) || a.name.localeCompare(b.name))
    .forEach((v) => {
      const o = document.createElement("option");
      o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
      sel.append(o);
    });
  if (saved && voices.some((v) => v.voiceURI === saved)) sel.value = saved;
}
$("voice").addEventListener("change", () => { store.set("voice", $("voice").value); if (R.playing) speak(); });
speechSynthesis.addEventListener("voiceschanged", loadVoices);
loadVoices();

// ---------- Boot ----------
applyTheme();
updateRateUI();
(async () => {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (res.ok) loadLibrary(); else show("login");
  } catch { show("login"); }
})();
