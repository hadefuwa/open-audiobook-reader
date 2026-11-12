// Single-user audiobook reader API: password login, files in R2, metadata in D1.

const COOKIE = "session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_UPLOAD = 90 * 1024 * 1024;
const ALLOWED = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
};

const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function makeToken(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
}

async function validToken(env, token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}

function getCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? m[1] : null;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: "Server not configured: set APP_PASSWORD and SESSION_SECRET" }, 500);
    }

    if (path === "/api/login" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
      const ok = typeof body.password === "string" && safeEqual(
        await hmac(env.SESSION_SECRET, body.password),
        await hmac(env.SESSION_SECRET, env.APP_PASSWORD),
      );
      if (!ok) return json({ error: "Wrong password" }, 401);
      const token = await makeToken(env);
      const secure = url.protocol === "https:" ? "; Secure" : "";
      return json({ ok: true }, 200, {
        "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`,
      });
    }

    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (!(await validToken(env, getCookie(request, COOKIE)))) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Reject cross-site state-changing requests.
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Bad origin" }, 403);
    }

    if (path === "/api/session") return json({ ok: true });

    if (path === "/api/books" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, title, filename, content_type, size, position, total, page_start, page_end, skip_pages, bookmarks, created_at, updated_at FROM books ORDER BY updated_at DESC",
      ).all();
      return json(results);
    }

    if (path === "/api/books" && request.method === "POST") {
      const filename = (url.searchParams.get("name") || "").slice(0, 200);
      const ext = extOf(filename);
      if (!ALLOWED[ext]) return json({ error: "Only PDF, DOCX and TXT files are supported" }, 400);
      const len = Number(request.headers.get("content-length") || 0);
      if (!len || len > MAX_UPLOAD) return json({ error: "File too large (max 90 MB) or empty" }, 413);
      const id = crypto.randomUUID();
      await env.FILES.put(id, request.body, { httpMetadata: { contentType: ALLOWED[ext] } });
      const title = filename.replace(/\.[^.]+$/, "") || "Untitled";
      await env.DB.prepare(
        "INSERT INTO books (id, title, filename, content_type, size) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, title, filename, ALLOWED[ext], len).run();
      return json({ id, title }, 201);
    }

    const m = path.match(/^\/api\/books\/([0-9a-f-]{36})(\/file|\/position|\/range|\/meta)?$/);
    if (m) {
      const [, id, sub] = m;
      const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
      if (!book) return json({ error: "Not found" }, 404);

      if (sub === "/file" && request.method === "GET") {
        const obj = await env.FILES.get(id);
        if (!obj) return json({ error: "File missing" }, 404);
        return new Response(obj.body, {
          headers: { "content-type": book.content_type, "cache-control": "private, max-age=3600" },
        });
      }

      if (sub === "/position" && request.method === "PUT") {
        let b;
        try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
        const position = Math.max(0, Math.floor(Number(b.position) || 0));
        const total = Math.max(0, Math.floor(Number(b.total) || 0));
        await env.DB.prepare("UPDATE books SET position = ?, total = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(position, total, id).run();
        return json({ ok: true });
      }

      if (sub === "/range" && request.method === "PUT") {
        let b;
        try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
        const page_start = Math.max(0, Math.floor(Number(b.page_start) || 0));
        const page_end = Math.max(0, Math.floor(Number(b.page_end) || 0));
        await env.DB.prepare("UPDATE books SET page_start = ?, page_end = ? WHERE id = ?")
          .bind(page_start, page_end, id).run();
        return json({ ok: true });
      }

      if (sub === "/meta" && request.method === "PUT") {
        let b;
        try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
        const sets = [], vals = [];
        if (typeof b.title === "string") {
          const t = b.title.trim().slice(0, 200);
          if (!t) return json({ error: "Title cannot be empty" }, 400);
          sets.push("title = ?"); vals.push(t);
        }
        if (typeof b.skip_pages === "string") { sets.push("skip_pages = ?"); vals.push(b.skip_pages.replace(/[^0-9, -]/g, "").slice(0, 500)); }
        if (Array.isArray(b.bookmarks)) {
          const clean = b.bookmarks.slice(0, 200).map((x) => ({
            i: Math.max(0, Math.floor(Number(x.i) || 0)),
            note: String(x.note || "").slice(0, 120),
            at: Math.floor(Number(x.at) || Date.now()),
          }));
          sets.push("bookmarks = ?"); vals.push(JSON.stringify(clean));
        }
        if (!sets.length) return json({ error: "Nothing to update" }, 400);
        await env.DB.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
        return json({ ok: true });
      }

      if (!sub && request.method === "DELETE") {
        await env.FILES.delete(id);
        await env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
