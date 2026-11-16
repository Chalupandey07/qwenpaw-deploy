/**
 * Harness helper: act as a SIGNED-IN browser on the /computer surface.
 *
 * WHY THIS EXISTS
 *
 * `/computer/*` gained a hard authentication gate on 2026-11-16 (see
 * `pages/public/session.js`): before it, an anonymous curl could read a
 * 1920x1080 screenshot of the desktop, take a control lease, and mint a
 * terminal capability — a pre-auth remote root shell.
 *
 * Every harness that drives the router is a fake *browser*, and a browser that
 * has signed in sends a session cookie. Without this helper the harnesses
 * would all fail at the gate, which would be a misleading red: the gate is
 * correct and the harness is what was out of date.
 *
 * It also gives the suite something it never had — a way to assert the gate
 * itself. `anon()` strips the cookie so a harness can prove a request is
 * REFUSED without one, which is the regression test for the P0 above.
 *
 * Usage:
 *   import { withSession, anon, sessionCookie } from "./_session.mjs";
 *   const call = (path, init) => worker.default.fetch(withSession(path, init), env, {});
 *   const anonCall = (path, init) => worker.default.fetch(anon(path, init), env, {});
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, "..", "..", "pages", "public");
const BASE = "https://qwenpawx.pages.dev";

/**
 * Mint a valid session cookie value against the same secret the harness puts
 * in `env`. Call this once after the env object exists.
 */
export async function sessionCookie(env) {
  const { mintSession } = await import("file://" + resolve(PUBLIC, "session.js"));
  const secret = env.COMPUTER_SESSION_SECRET || env.COMPUTER_CAPABILITY_SECRET;
  const value = await mintSession(secret, { ttlMs: 60 * 60 * 1000 });
  if (!value) throw new Error("harness: cannot mint a session — no secret in env");
  return value;
}

/** Build a Request for `path` carrying the given session cookie. */
export function requestWith(path, init, cookie) {
  const url = String(path).startsWith("http") ? String(path) : BASE + String(path);
  const headers = new Headers((init && init.headers) || {});
  headers.set("Cookie", `DESKTOP_SESSION=${cookie}`);
  return new Request(url, { ...(init || {}), headers });
}

/** A Request with NO cookie — for asserting the gate refuses it. */
export function anon(path, init) {
  const url = String(path).startsWith("http") ? String(path) : BASE + String(path);
  return new Request(url, init || {});
}
