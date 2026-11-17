// Shared API logic for Swing & Swig. Runs as a Netlify Function in production
// and inside dev-server.mjs locally. `store` is a Netlify Blobs store (or the
// in-memory stand-in from dev-server.mjs) holding four JSON blobs:
//   config  – event setup, teams, pars, lock flag
//   scores  – { [teamId]: { holes: { [hole]: strokes | "P" }, updatedAt } }
//   adjust  – chair rulings [{ id, teamId, points, reason, hidden, at }]
//   chat    – messages [{ id, uid, name, teamId, text, media?, at, reactions }]
// plus uploaded photos/videos under media/<id>/meta and media/<id>/<chunk#>.
// Netlify Functions accept ~6 MB per request, so files arrive in 3 MB chunks
// and are served back with HTTP Range support (iPhones need it for video).
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export const REACTS = ["up", "lol", "fire", "flag", "beer", "clap"];
const DEFAULT_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];
const CHAT_KEEP = 300;
const CHAT_SEND = 150;
const MEDIA_CHUNK = 3 * 1024 * 1024;
const MEDIA_TYPES = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/gif": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video", "video/x-m4v": "video", "video/3gpp": "video",
};
const MEDIA_MAX = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 };
const mkey = (id, part) => `media/${id}/${part}`;
const isId = (v) => typeof v === "string" && /^[a-f0-9]{16}$/.test(v);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, "invalid", msg);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const sha = (s) => createHash("sha256").update(String(s)).digest();
const newId = () => randomBytes(8).toString("hex");
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function chairFrom(req, pin) {
  const given = req.headers.get("x-chair-pin") || "";
  return !!pin && !!given && timingSafeEqual(sha(given), sha(pin));
}
function uidFrom(req) {
  const key = req.headers.get("x-client-key") || "";
  if (key.length < 16 || key.length > 128) return null;
  return createHash("sha256").update("uid:" + key).digest("hex").slice(0, 16);
}
function needChair(chair) {
  if (!chair) throw new HttpError(403, "not_chair", "Only the tournament chair can do that.");
}

function defaultConfig() {
  return { name: "Swing and Swig", course: "Pearl at Kalauao", date: "", holes: 18, pars: DEFAULT_PARS.slice(), teams: [], locked: false };
}

async function read(store, key, fallback) {
  const v = await store.get(key, { type: "json" });
  return v ?? fallback;
}

// Read-modify-write with optimistic concurrency, so two phones saving at the
// same moment can't clobber each other.
async function mutate(store, key, fallback, fn) {
  for (let i = 0; i < 10; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const next = fn(cur ? cur.data : structuredClone(fallback));
    const res = await store.setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return next;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 100));
  }
  throw new HttpError(503, "busy", "The server is busy. Try again.");
}

function cleanConfig(b, locked) {
  const holes = +b.holes === 9 ? 9 : 18;
  const parsIn = Array.isArray(b.pars) ? b.pars : [];
  const pars = [];
  for (let i = 0; i < holes; i++) {
    const p = Math.round(+parsIn[i]);
    pars.push(p >= 3 && p <= 6 ? p : DEFAULT_PARS[i]);
  }
  const seen = new Set();
  const teams = (Array.isArray(b.teams) ? b.teams : [])
    .slice(0, 60)
    .map((t) => ({
      id: /^[A-Za-z0-9_-]{1,24}$/.test(t?.id) ? t.id : "t" + newId().slice(0, 8),
      name: str(t?.name, 40),
      players: str(t?.players, 120),
    }))
    .filter((t) => t.name && !seen.has(t.id) && seen.add(t.id));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "";
  return { name: str(b.name, 80) || "Swing and Swig", course: str(b.course, 80), date, holes, pars, teams, locked: !!locked };
}

async function state(store, chair, uid) {
  const [config, scores, adjust, chat] = await Promise.all([
    read(store, "config", null),
    read(store, "scores", {}),
    read(store, "adjust", []),
    read(store, "chat", []),
  ]);
  return {
    config,
    scores,
    // Hidden rulings stay secret until the chair reveals them.
    adjust: chair ? adjust : adjust.filter((a) => !a.hidden),
    chat: chat.slice(-CHAT_SEND),
    isChair: chair,
    me: uid,
  };
}

async function putScore(store, b, chair) {
  const config = (await read(store, "config", null)) || defaultConfig();
  const team = String(b.team || "");
  if (!config.teams.some((t) => t.id === team)) throw bad("Unknown team.");
  const hole = Math.round(+b.hole);
  const holes = config.holes || config.pars.length || 18;
  if (!(hole >= 1 && hole <= holes)) throw bad("Unknown hole.");
  let val = b.val;
  if (val !== null && val !== "P") {
    val = Math.round(+val);
    if (!(val >= 1 && val <= 15)) throw bad("Strokes must be 1 to 15.");
  }
  if (config.locked && !chair) throw new HttpError(403, "locked", "Scorecards are locked.");
  const scores = await mutate(store, "scores", {}, (all) => {
    const cur = all[team] || { holes: {} };
    const holesMap = { ...cur.holes };
    if (val === null) delete holesMap[hole];
    else holesMap[hole] = val;
    all[team] = { holes: holesMap, updatedAt: Date.now() };
    return all;
  });
  return { scores };
}

async function mediaMeta(store, id) {
  if (!isId(id)) throw new HttpError(404, "not_found", "No such file.");
  const meta = await read(store, mkey(id, "meta"), null);
  if (!meta) throw new HttpError(404, "not_found", "No such file.");
  return meta;
}

async function deleteMedia(store, id) {
  if (!isId(id)) return;
  const meta = await read(store, mkey(id, "meta"), null);
  if (!meta) return;
  await Promise.all([...Array(meta.chunks).keys()].map((n) => store.delete(mkey(id, n))));
  await store.delete(mkey(id, "meta"));
}

async function serveMedia(store, id, req) {
  const meta = await mediaMeta(store, id);
  if (!meta.complete) throw new HttpError(404, "not_found", "Still uploading.");
  // Chrome plays H.264 .mov files when they're labelled mp4; Safari doesn't mind either way.
  const type = meta.type === "video/quicktime" ? "video/mp4" : meta.type;
  const headers = {
    "content-type": type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "public, max-age=31536000, immutable",
  };
  const chunk = async (n) => {
    const buf = await store.get(mkey(id, n), { type: "arrayBuffer" });
    if (!buf) throw new HttpError(404, "not_found", "File is missing a piece.");
    return buf;
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get("range") || "").trim());
  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1] === "") {
      start = Math.max(0, meta.size - +m[2]);
      end = meta.size - 1;
    } else {
      start = +m[1];
      end = m[2] === "" ? meta.size - 1 : Math.min(+m[2], meta.size - 1);
    }
    if (start >= meta.size || start > end)
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${meta.size}` } });
    // Answer from a single stored chunk; players ask again for the rest.
    const ci = Math.floor(start / meta.chunkSize), base = ci * meta.chunkSize;
    end = Math.min(end, base + meta.chunkSize - 1);
    const buf = await chunk(ci);
    return new Response(buf.slice(start - base, end - base + 1), {
      status: 206,
      headers: { ...headers, "cache-control": "private, max-age=86400", "content-range": `bytes ${start}-${end}/${meta.size}` },
    });
  }
  if (meta.chunks === 1)
    return new Response(await chunk(0), { status: 200, headers: { ...headers, "netlify-cdn-cache-control": "public, max-age=604800" } });
  let n = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (n >= meta.chunks) return ctrl.close();
      ctrl.enqueue(new Uint8Array(await chunk(n++)));
    },
  });
  return new Response(body, { status: 200, headers: { ...headers, "content-length": String(meta.size) } });
}

async function media(store, req, method, uid, b, c) {
  if (method === "GET" && b && c === "file") return serveMedia(store, b, req);
  if (!uid) throw new HttpError(400, "no_key", "Missing client key.");
  if (method === "POST" && !b) {
    const body = await req.json().catch(() => ({}));
    const kind = MEDIA_TYPES[body.type];
    if (!kind) throw bad("Only photos (JPEG, PNG, WebP, GIF) and videos (MP4, MOV, WebM) can be shared.");
    const size = Math.round(+body.size);
    if (!(size > 0)) throw bad("That file is empty.");
    if (size > MEDIA_MAX[kind])
      throw new HttpError(413, "too_big", kind === "video" ? "Videos can be up to 50 MB. Try a shorter clip." : "Photos can be up to 10 MB.");
    const dim = (v) => (Number.isFinite(+v) && +v > 0 && +v < 20000 ? Math.round(+v) : 0);
    const id = newId();
    const meta = { id, uid, type: body.type, kind, size, chunkSize: MEDIA_CHUNK, chunks: Math.ceil(size / MEDIA_CHUNK), w: dim(body.w), h: dim(body.h), complete: false, at: Date.now() };
    await store.setJSON(mkey(id, "meta"), meta);
    return json({ id, chunkSize: MEDIA_CHUNK, chunks: meta.chunks });
  }
  const meta = await mediaMeta(store, b);
  if (meta.uid !== uid) throw new HttpError(403, "not_owner", "That upload belongs to someone else.");
  if (method === "PUT" && /^\d+$/.test(c || "")) {
    const n = +c;
    if (meta.complete || n >= meta.chunks) throw bad("Unexpected piece.");
    const buf = await req.arrayBuffer();
    const want = Math.min(meta.chunkSize, meta.size - n * meta.chunkSize);
    if (buf.byteLength !== want) throw bad("That piece is the wrong size.");
    await store.set(mkey(meta.id, n), buf);
    return json({ ok: true });
  }
  if (method === "POST" && c === "done") {
    const have = await Promise.all([...Array(meta.chunks).keys()].map((n) => store.getMetadata(mkey(meta.id, n))));
    if (have.some((x) => !x)) throw bad("Upload isn't finished.");
    await mutate(store, mkey(meta.id, "meta"), null, (cur) => ({ ...cur, complete: true }));
    return json({ media: { id: meta.id, kind: meta.kind, w: meta.w, h: meta.h } });
  }
  throw new HttpError(404, "not_found", "No such endpoint.");
}

export async function handle(req, { store, chairPin }) {
  const url = new URL(req.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const chair = chairFrom(req, chairPin);
  const uid = uidFrom(req);

  try {
    if (a === "media") return await media(store, req, method, uid, b, c);

    let body = {};
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        body = await req.json();
      } catch {
        throw bad("Request body must be JSON.");
      }
      if (!body || typeof body !== "object") throw bad("Request body must be an object.");
    }

    // ---- read everything ----
    if (method === "GET" && a === "state") return json(await state(store, chair, uid));

    // ---- chair sign-in check ----
    if (method === "POST" && a === "chair" && b === "check") {
      if (!chairPin) throw new HttpError(503, "no_pin", "CHAIR_PIN isn't set in Netlify yet.");
      if (!chair) throw new HttpError(403, "bad_pin", "That PIN isn't right.");
      return json({ ok: true });
    }

    // ---- scores ----
    if (method === "POST" && a === "score" && !b) return json(await putScore(store, body, chair));

    // ---- event setup ----
    if (a === "config" && !b && method === "PUT") {
      needChair(chair);
      const config = await mutate(store, "config", null, (cur) => cleanConfig(body, cur?.locked));
      return json({ config });
    }
    if (a === "config" && !b && method === "PATCH") {
      needChair(chair);
      const config = await mutate(store, "config", null, (cur) => ({ ...(cur || defaultConfig()), locked: !!body.locked }));
      return json({ config });
    }

    // ---- chair rulings ----
    if (a === "adjust") {
      needChair(chair);
      if (method === "POST" && !b) {
        const points = Math.round(+body.points);
        if (!(points >= -10 && points <= 10) || !points) throw bad("Points must be -10 to 10 and not zero.");
        const teamId = String(body.teamId || "");
        const item = { id: newId(), teamId, points, reason: str(body.reason, 120), hidden: !!body.hidden, at: Date.now() };
        await mutate(store, "adjust", [], (list) => [...list, item].slice(-500));
        return json({ item });
      }
      if (b && method === "PATCH") {
        await mutate(store, "adjust", [], (list) => list.map((x) => (x.id === b ? { ...x, hidden: !!body.hidden } : x)));
        return json({ ok: true });
      }
      if (b && method === "DELETE") {
        await mutate(store, "adjust", [], (list) => list.filter((x) => x.id !== b));
        return json({ ok: true });
      }
    }

    // ---- chat ----
    if (a === "chat") {
      if (!uid) throw new HttpError(400, "no_key", "Missing client key.");
      if (method === "POST" && !b) {
        const text = str(body.text, 280);
        const name = str(body.name, 30);
        let attached = null;
        if (body.media) {
          const meta = await mediaMeta(store, body.media.id);
          if (meta.uid !== uid || !meta.complete) throw bad("That photo or video hasn't finished uploading.");
          attached = { id: meta.id, kind: meta.kind, w: meta.w, h: meta.h };
        }
        if (!text && !attached) throw bad("Message is empty.");
        if (!name) throw bad("Add your name first.");
        const msg = { id: newId(), uid, name, teamId: str(body.teamId, 24), text, at: Date.now(), reactions: {} };
        if (attached) msg.media = attached;
        let dropped = [];
        await mutate(store, "chat", [], (list) => {
          const all = [...list, msg];
          dropped = all.slice(0, Math.max(0, all.length - CHAT_KEEP));
          return all.slice(-CHAT_KEEP);
        });
        await Promise.all(dropped.filter((m) => m.media).map((m) => deleteMedia(store, m.media.id)));
        return json({ msg });
      }
      if (b && c === "react" && method === "POST") {
        const k = String(body.k || "");
        if (!REACTS.includes(k)) throw bad("Unknown reaction.");
        await mutate(store, "chat", [], (list) =>
          list.map((m) => {
            if (m.id !== b) return m;
            const set = { ...(m.reactions?.[k] || {}) };
            if (body.on) set[uid] = true;
            else delete set[uid];
            return { ...m, reactions: { ...(m.reactions || {}), [k]: set } };
          })
        );
        return json({ ok: true });
      }
      if (b && !c && method === "DELETE") {
        let denied = false, removed = null;
        await mutate(store, "chat", [], (list) => {
          const m = list.find((x) => x.id === b);
          denied = !!(m && m.uid !== uid && !chair);
          removed = denied ? null : m;
          return denied ? list : list.filter((x) => x.id !== b);
        });
        if (denied) throw new HttpError(403, "not_owner", "You can only delete your own messages.");
        if (removed?.media) await deleteMedia(store, removed.media.id);
        return json({ ok: true });
      }
    }

    throw new HttpError(404, "not_found", "No such endpoint.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: "Server error.", code: "server" }, 500);
  }
}
