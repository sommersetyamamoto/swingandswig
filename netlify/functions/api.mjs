import { getStore } from "@netlify/blobs";
import { handle } from "../../src/handler.mjs";

export default async (req) =>
  handle(req, {
    store: getStore({ name: "swing-and-swig", consistency: "strong" }),
    chairPin: globalThis.Netlify?.env?.get("CHAIR_PIN") ?? process.env.CHAIR_PIN ?? "",
  });

export const config = { path: "/api/*" };
