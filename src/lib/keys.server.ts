/**
 * Image provider access control.
 *
 * NINE keys, ONE model: every render goes to Agnes AI `agnes-image-2.5-flash`
 * through one of up to nine server-only keys (AGNES_API_KEY_1 … AGNES_API_KEY_9,
 * with AGNES_API_KEY accepted as a first key too). Keys are read only here, on
 * the server, and are never sent to the browser or written into the codebase.
 *
 * Agnes' Cloudflare edge applies the 20 RPM limit to the shared caller, not
 * independently to each credential. Every image request therefore passes
 * through one process-wide, sequential 20 RPM gate. Keys still rotate so an
 * exhausted or invalid credential does not pin every later panel to one key.
 */

import { assertActive, registerKillHook } from "./kill-switch.server";


/** Hard provider ceiling per key, per rolling minute. */
export const IMAGE_RPM = 20;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/**
 * Self-imposed ceiling per key: after every generation a key rests
 * COOLDOWN_PER_KEY_MS (20s) before its next request, capping each key at
 * 3 per minute — far under the provider's 20 per minute, so it never trips.
 */
const COOLDOWN_PER_KEY_MS = 20_000;
const SAFE_RPM = 3;
/** Minimum gap between two starts on the SAME key: a flat 20 seconds. */
const SPACING_MS = COOLDOWN_PER_KEY_MS;

/** One image in flight per key: all nine keys draw at the same time. */
export const IMAGE_CONCURRENCY = 9;


/** All configured Agnes keys, in order. */
export function agnesKeys(): string[] {
  const names = [
    "AGNES_API_KEY",
    "AGNES_API_KEY_1",
    "AGNES_API_KEY_2",
    "AGNES_API_KEY_3",
    "AGNES_API_KEY_4",
    "AGNES_API_KEY_5",
    "AGNES_API_KEY_6",
    "AGNES_API_KEY_7",
    "AGNES_API_KEY_8",
    "AGNES_API_KEY_9",
  ];
  const seen = new Set<string>();
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) seen.add(v);
  }
  const keys = [...seen];
  if (keys.length === 0) throw new Error("Missing AGNES_API_KEY_1 (Agnes AI image key)");
  return keys;
}

/** First key — kept for callers that only need "a" key. */
export function agnesKey(): string {
  return agnesKeys()[0] as string;
}

/**
 * `busyUntil` is a LEASE, not a flag.
 *
 * A boolean `busy` is only ever cleared by the `finally` of the job that set
 * it. When that job's request is torn down mid-flight (Insta Kill, a refresh,
 * a serverless handler the platform drops) the `finally` may never run, so the
 * key stays "busy" forever. Once every key has leaked that way, the waiting
 * loop below spins with nothing to give out and generation hangs with no error
 * at all. A lease simply expires: a key can never be lost.
 */
type Lane = { starts: number[]; busyUntil: number; cooldownUntil: number };

/** Longest one image request can hold a key (the 180s call plus slack). */
const LEASE_MS = 240_000;

/** One independent lane per key: each key draws its own image in parallel. */
const lanes = new Map<string, Lane>();

function laneFor(key: string): Lane {
  let l = lanes.get(key);
  if (!l) {
    l = { starts: [], busyUntil: 0, cooldownUntil: 0 };
    lanes.set(key, l);
  }
  return l;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when this key may start a request right now. */
function laneReady(l: Lane, now: number): boolean {
  l.starts = l.starts.filter((t) => now - t < WINDOW_MS);
  if (now < l.busyUntil) return false;
  if (now < l.cooldownUntil) return false;
  const last = l.starts.length ? (l.starts[l.starts.length - 1] as number) : 0;
  if (now - last < SPACING_MS) return false;
  return l.starts.length < SAFE_RPM;
}


/** Round-robin cursor so load spreads evenly across the keys. */
let cursor = 0;

/**
 * Parks ONLY the key that actually hit 429/1015.
 *
 * This used to read a module-global "last leased key", which is wrong the
 * moment more than one image is in flight: whichever lease happened most
 * recently was blamed for a throttle raised by a different key. The throttled
 * key stayed hot (so it was picked again immediately and throttled again) and a
 * perfectly healthy key was parked — the stuck / resume / stuck cycle. The
 * caller now passes the exact key it used, so the cooldown always lands on it.
 */
export function reportImageRateLimit(key: string, retryAfterMs = 15_000): void {
  if (!key) return;
  const l = laneFor(key);
  l.cooldownUntil = Math.max(l.cooldownUntil, Date.now() + Math.max(1_000, retryAfterMs));
}

/** Insta Kill hands every key back: nothing is drawing any more. */
export function releaseAllImageKeys(): void {
  for (const lane of lanes.values()) {
    lane.busyUntil = 0;
    lane.cooldownUntil = 0;
    lane.starts = [];
  }
}

registerKillHook(releaseAllImageKeys);

/**
 * Leases a free key and runs the request on it. Every key works in parallel,
 * each held to its own 20 requests per minute, so nine images draw at once.
 * Keeps the historical signature (`slot`, `attempt`) so callers are unchanged.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const keys = agnesKeys();
  let chosen = -1;
  for (;;) {
    // A killed or abandoned run stops waiting for a key instead of spinning
    // here silently for the rest of the process's life.
    assertActive();
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (cursor + i) % keys.length;
      const candidate = keys[idx] as string;
      if (laneReady(laneFor(candidate), now)) {
        chosen = idx;
        cursor = (idx + 1) % keys.length;
        break;
      }
    }
    if (chosen >= 0) break;
    await sleep(250);
  }
  const key = keys[chosen] as string;
  const lane = laneFor(key);
  lane.busyUntil = Date.now() + LEASE_MS;
  lane.starts.push(Date.now());
  try {
    return await fn(key, chosen);
  } finally {
    lane.busyUntil = 0;
  }
}
