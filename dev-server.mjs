// Local preview without the Netlify CLI: `npm run dev`, then open http://localhost:8888
// Data lives in memory and resets when you stop the server.
// Chair PIN defaults to 1234 locally (override with CHAIR_PIN=...).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handle } from "./src/handler.mjs";

const PORT = +process.env.PORT || 8888;
const chairPin = process.env.CHAIR_PIN ?? "1234";
const ROOT = new URL("./public/", import.meta.url).pathname;

// Minimal stand-in for a Netlify Blobs store (get / getWithMetadata / setJSON with conditions).
const mem = new Map();
let n = 0;
const store = {
  async get(key) {
    const e = mem.get(key);
    return e ? structuredClone(e.data) : null;
  },
  async getWithMetadata(key) {
    const e = mem.get(key);
    return e ? { data: structuredClone(e.data), etag: e.etag, metadata: {} } : null;
  },
  async setJSON(key, data, opts = {}) {
    const e = mem.get(key);
    if (opts.onlyIfNew && e) return { modified: false };
    if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = String(++n);
    mem.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  },
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body }), { store, chairPin });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const p = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!p.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const data = await readFile(p);
      res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }).end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, () => console.log(`Swing & Swig running at http://localhost:${PORT}  (chair PIN: ${chairPin})`));
