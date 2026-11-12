# Open Audiobook Reader

A free, open-source web app that reads your own PDF, Word (.docx) and text files aloud. Upload once, press play, and listen on your phone or computer. Your position is remembered.

Two ways to run it:

| | Where it runs | Needs internet | Sync between devices |
|---|---|---|---|
| **Cloud** (this folder) | Your own Cloudflare account (free tier) | Yes | Yes |
| **Offline** (`local/`) | Your own computer | No | No |

Everything stays under your control. There is no tracking, no account with us, and nothing is sent anywhere except your own Cloudflare account.

## Features

- Upload PDF, DOCX and TXT files
- Read only a page range (skip covers, contents, author notes)
- Skips repeated page headers, footers and page numbers in PDFs
- Handles awkward PDFs that store one glyph at a time
- Highlights the sentence being read; click any sentence to jump there
- Speed and voice selection, using your browser's built-in voices
- Saves your place; lock-screen controls via Media Session; screen wake lock while playing
- Light and dark theme

## Option 1: Offline on your own computer

Needs [Node.js](https://nodejs.org) (any recent version).

```bash
cd local
node server.js
```

Then open http://localhost:8765. On Windows you can double-click `local/start.bat`.

Books are stored in your browser (IndexedDB), so use the same browser each time. Clearing site data deletes them. For speech without internet, choose a voice that is **not** marked `[needs internet]`. Operating-system voices work offline; Chrome's Google voices and Edge's "Natural" voices usually need a connection.

## Option 2: Host it yourself on Cloudflare (free)

The cloud version uses Cloudflare Workers (site and API), R2 (file storage) and D1 (library and reading position). It is protected by a single password, so it is intended for one person.

### What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) 18 or newer
- **R2 enabled** on your account: Cloudflare dashboard, then **R2 Object Storage**, then complete the one-time sign-up. R2 may ask for a payment method to activate, but the free allowance (10 GB storage, no egress fees) is plenty for books. Without this step, bucket creation fails with error 10042.

### Steps

```bash
git clone https://github.com/hadefuwa/open-audiobook-reader.git
cd open-audiobook-reader
npm install

# 1. Log in to Cloudflare in your browser
npx wrangler login

# 2. Create storage
npx wrangler r2 bucket create audiobook-files
npx wrangler d1 create audiobook-db
```

The `d1 create` command prints a `database_id`. Open `wrangler.jsonc` and replace `PASTE-YOUR-DATABASE-ID-HERE` with it.

```bash
# 3. Create the database tables
npm run db:remote

# 4. Set your password and a signing secret (you will be prompted; nothing is stored in the repo)
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET     # any long random string

# 5. Deploy
npm run deploy
```

Wrangler prints your site address, something like `https://audiobook-reader.<your-subdomain>.workers.dev`. Open it, sign in with the password, and upload a book.

Names are yours to change: edit `name` in `wrangler.jsonc` to change the address, or the bucket and database names (keep the `binding` values `FILES` and `DB` as they are).

### Updating later

```bash
git pull
npm run db:remote   # applies any new database migrations
npm run deploy
```

### Run the cloud version locally

```bash
cp .dev.vars.example .dev.vars   # then edit the password and secret
npm run db:local
npm run dev
```

On Windows, keep the project in a short path such as `C:\dev\audiobook`. Very long paths stop `workerd` from starting.

### Free tier notes

Cloudflare's free limits change over time, so check the current numbers. At the time of writing they comfortably cover personal use: Workers 100,000 requests a day, D1 5 GB, R2 10 GB. Uploads are limited to 90 MB per file because of the Workers request size limit.

### Security notes

- Single user only: one shared password, HMAC-signed session cookie, same-origin checks on writes.
- Choose a strong `APP_PASSWORD`. Never commit `.dev.vars` (it is git-ignored).
- Only upload files you have the right to use. Your library is private to your deployment.

## Project layout

```
public/      Website (HTML, CSS, JS). pdf.js and mammoth load from cdnjs.
src/         Worker API (login, books, reading position)
migrations/  D1 database schema
local/       Standalone offline version (vendored libraries, no server API)
```

`local/pdftext.js` is a copy of `public/pdftext.js`; keep them in sync when changing PDF handling.

## Limits

- Scanned PDFs (pictures of pages) have no text layer, so there is nothing to read. OCR is not included yet.
- Tables and diagrams in PDFs can read out as jumbled text.
- Browser voices vary by device. On some phones playback pauses when the screen locks; the app requests a wake lock while playing.

## Ideas for the future

- Optional neural voice in the browser (for example Kokoro) for more natural narration
- OCR for scanned PDFs
- Chapter navigation and bookmarks
- Installable PWA

## Contributing

Issues and pull requests are welcome. Keep it dependency-light and privacy-respecting.

## License

MIT. See [LICENSE](LICENSE). pdf.js (Apache-2.0, Mozilla) and mammoth (BSD-2-Clause) are used under their own licences.
