// Shared API logic for Swing & Swig. Runs as a Netlify Function in production
// and inside dev-server.mjs locally. `store` is a Netlify Blobs store (or the
// in-memory stand-in from dev-server.mjs) holding four JSON blobs:
//   config  – event setup, teams, pars, lock flag
//   scores  – { [teamId]: { holes: { [hole]: strokes | "P" }, updatedAt } }
//   adjust  – chair rulings [{ id, teamId, points, reason, hidden, at }]
//   chat    – messages [{ id, uid, name, teamId, text, media?, at, reactions }]
//             plus chair rulings echoed into chat: { kind: "ruling", ruling: { adjustId, teamId, points, reason } }
// plus uploaded photos/videos under media/<id>/meta and media/<id>/<chunk#>.
// Netlify Functions accept ~6 MB per request, so files arrive in 3 MB chunks
// and are served back with HTTP Range support (iPhones need it for video).
//   push    – { [uid]: { sub, prefs: "rulings" | "all", at } } phone notification subscriptions
//   vapid   – the site's push signing keys, created on first use (or set
//             VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Netlify to supply your own)
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import * as webpush from "web-push";

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

/* ---------- phone notifications (Web Push) ---------- */
// Only send to real browser push services, so nobody can make the server POST to arbitrary URLs.
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/;

async function vapidKeys(store) {
  const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
  if (env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY")) return { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY") };
  const have = await read(store, "vapid", null);
  if (have) return have;
  const made = webpush.generateVAPIDKeys();
  const res = await store.setJSON("vapid", made, { onlyIfNew: true });
  return res.modified ? made : await read(store, "vapid", null);
}

function cleanSub(sub) {
  let host = "";
  try {
    const u = new URL(sub?.endpoint);
    if (u.protocol !== "https:") throw 0;
    host = u.hostname;
  } catch {
    throw bad("That isn't a valid notification subscription.");
  }
  const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100)
    throw bad("That isn't a valid notification subscription.");
  if (!PUSH_HOSTS.test(host) && !process.env.ALLOW_ANY_PUSH_ENDPOINT) throw bad("Unknown notification service.");
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

// kind "ruling" goes to everyone subscribed; kind "chat" only to people who chose "all".
async function notify(ctx, payload, { kind, skipUid = null, onlyUid = null }) {
  const subs = await read(ctx.store, "push", {});
  const targets = Object.entries(subs).filter(([u, s]) =>
    onlyUid ? u === onlyUid : u !== skipUid && (kind !== "chat" || s.prefs === "all")
  );
  if (!targets.length) return;
  const keys = await vapidKeys(ctx.store);
  const opts = {
    vapidDetails: {
      subject: ctx.origin.startsWith("https://") ? ctx.origin : "mailto:notifications@example.com",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    },
    TTL: kind === "chat" ? 1800 : 6 * 3600,
    urgency: kind === "chat" ? "normal" : "high",
    timeout: 8000,
  };
  const gone = [];
  await Promise.all(
    targets.map(async ([u, s]) => {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify(payload), opts);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) gone.push(u);
        else console.error("push failed", e.statusCode || e.message);
      }
    })
  );
  if (gone.length)
    await mutate(ctx.store, "push", {}, (all) => {
      gone.forEach((u) => delete all[u]);
      return all;
    });
}

async function teamName(store, id) {
  const config = await read(store, "config", null);
  return config?.teams?.find((t) => t.id === id)?.name || "";
}

async function appendChat(store, msg) {
  let dropped = [];
  await mutate(store, "chat", [], (list) => {
    const all = [...list, msg];
    dropped = all.slice(0, Math.max(0, all.length - CHAT_KEEP));
    return all.slice(-CHAT_KEEP);
  });
  await Promise.all(dropped.filter((m) => m.media).map((m) => deleteMedia(store, m.media.id)));
}

// A ruling shows in chat once it's public; hiding or removing it takes it back out.
async function postRuling(ctx, item) {
  await appendChat(ctx.store, {
    id: newId(), uid: "", name: "Tournament chair", kind: "ruling", text: "", at: Date.now(), reactions: {},
    ruling: { adjustId: item.id, teamId: item.teamId, points: item.points, reason: item.reason },
  });
  ctx.later(async () => {
    const team = (await teamName(ctx.store, item.teamId)) || "A team";
    const pts = `${item.points > 0 ? "+" : ""}${item.points}`;
    await notify(ctx, { title: "⚖️ Chair's ruling", body: `${pts} ${team}: ${item.reason || "The chair's decision is final."}`, url: "/#chat", tag: "ruling-" + item.id }, { kind: "ruling" });
  });
}
const unpostRuling = (store, adjustId) =>
  mutate(store, "chat", [], (list) => list.filter((m) => m.ruling?.adjustId !== adjustId));

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

export async function handle(req, { store, chairPin, waitUntil }) {
  const url = new URL(req.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const chair = chairFrom(req, chairPin);
  const uid = uidFrom(req);
  // Notifications go out after the response when the platform allows it (Netlify's waitUntil).
  const ctx = {
    store,
    origin: url.origin,
    async later(fn) {
      const p = Promise.resolve().then(fn).catch((e) => console.error("background task failed", e));
      if (waitUntil) waitUntil(p);
      else await p;
    },
  };

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
      if (!chair) throw new HttpError(403, "bad_pin", "That password isn't right.");
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
        if (!item.hidden) await postRuling(ctx, item);
        return json({ item });
      }
      if (b && method === "PATCH") {
        let before = null, after = null;
        await mutate(store, "adjust", [], (list) =>
          list.map((x) => {
            if (x.id !== b) return x;
            before = x;
            return (after = { ...x, hidden: !!body.hidden });
          })
        );
        if (before && after && before.hidden && !after.hidden) await postRuling(ctx, after);
        if (before && after && !before.hidden && after.hidden) await unpostRuling(store, b);
        return json({ ok: true });
      }
      if (b && method === "DELETE") {
        await mutate(store, "adjust", [], (list) => list.filter((x) => x.id !== b));
        await unpostRuling(store, b);
        return json({ ok: true });
      }
    }

    // ---- phone notifications ----
    if (a === "push") {
      if (method === "GET" && b === "key") return json({ key: (await vapidKeys(store)).publicKey });
      if (!uid) throw new HttpError(400, "no_key", "Missing client key.");
      if (method === "GET" && b === "me") {
        const mine = (await read(store, "push", {}))[uid];
        return json({ prefs: mine ? mine.prefs : null });
      }
      if (method === "POST" && b === "subscribe") {
        const sub = cleanSub(body.subscription);
        const prefs = body.prefs === "all" ? "all" : "rulings";
        await mutate(store, "push", {}, (all) => {
          // One phone, one entry: drop any older entry for the same endpoint.
          for (const [u, s] of Object.entries(all)) if (s.sub.endpoint === sub.endpoint) delete all[u];
          all[uid] = { sub, prefs, at: Date.now() };
          return Object.fromEntries(Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, 500));
        });
        return json({ prefs });
      }
      if (method === "POST" && b === "unsubscribe") {
        await mutate(store, "push", {}, (all) => {
          delete all[uid];
          return all;
        });
        return json({ ok: true });
      }
      if (method === "POST" && b === "test") {
        await notify(ctx, { title: "⛳ Swing & Swig", body: "Notifications are working. See you on the course!", url: "/#chat", tag: "test" }, { kind: "test", onlyUid: uid });
        return json({ ok: true });
      }
    }

    // ---- chat ----
    if (a === "chat") {
      if (!uid) throw new HttpError(400, "no_key", "Missing client key.");
      if (method === "POST" && !b) {
        const text = str(body.text, 280);
        const name = str(body.name, 40);
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
        await appendChat(store, msg);
        await ctx.later(async () => {
          const team = await teamName(store, msg.teamId);
          const body = msg.text || (msg.media?.kind === "video" ? "🎬 Sent a video" : "📷 Sent a photo");
          await notify(ctx, { title: name + (team ? ` · ${team}` : ""), body, url: "/#chat", tag: "chat" }, { kind: "chat", skipUid: uid });
        });
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
