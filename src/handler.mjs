// Shared API logic for Swing & Swig. Runs as a Netlify Function in production
// and inside dev-server.mjs locally. `store` is a Netlify Blobs store (or the
// in-memory stand-in from dev-server.mjs) holding four JSON blobs:
//   config  – event setup, teams, pars, lock flag
//   scores  – { [teamId]: { holes: { [hole]: strokes | "P" }, updatedAt } }
//   adjust  – chair rulings [{ id, teamId, points, reason, hidden, at }]
//   chat    – messages [{ id, uid, name, teamId, text, at, reactions }]
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

export const REACTS = ["up", "lol", "fire", "flag", "beer", "clap"];
const DEFAULT_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];
const CHAT_KEEP = 300;
const CHAT_SEND = 150;

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
  return { name: "Swing and Swig", course: "Kalauao Golf Course", date: "", holes: 18, pars: DEFAULT_PARS.slice(), teams: [], locked: false };
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

export async function handle(req, { store, chairPin }) {
  const url = new URL(req.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const chair = chairFrom(req, chairPin);
  const uid = uidFrom(req);

  try {
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
        if (!text) throw bad("Message is empty.");
        if (!name) throw bad("Add your name first.");
        const msg = { id: newId(), uid, name, teamId: str(body.teamId, 24), text, at: Date.now(), reactions: {} };
        await mutate(store, "chat", [], (list) => [...list, msg].slice(-CHAT_KEEP));
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
        let denied = false;
        await mutate(store, "chat", [], (list) => {
          const m = list.find((x) => x.id === b);
          if (m && m.uid !== uid && !chair) {
            denied = true;
            return list;
          }
          return list.filter((x) => x.id !== b);
        });
        if (denied) throw new HttpError(403, "not_owner", "You can only delete your own messages.");
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
