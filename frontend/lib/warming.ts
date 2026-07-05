"use client";

/**
 * Tells a real backend cold start apart from a merely slow request, and exposes
 * a hook the WarmingBar reacts to.
 *
 * Why not just time the request? A request can be slow for two unrelated
 * reasons: the api KSvc is scaled to zero and waking up (cold start, ~30s), or
 * the backend is warm but that one call is heavy. Timing alone can't tell them
 * apart, so the old "in flight > 5s ⇒ cold" heuristic cried wolf on every slow
 * call. Instead, once something has been slow for a beat, we *ask the server*:
 * fire a dependency-free liveness probe (`/api/health/live`) with a short
 * timeout.
 *
 *   - Cold: Knative's activator buffers ALL requests (the probe included) until
 *     a pod is Ready, so the probe times out → we're genuinely warming.
 *   - Warm: the probe answers in ~1ms even while the heavy call is still in
 *     flight → it's ordinary slowness, NOT a cold start → banner stays off.
 *
 * Module-level state lets `tracked()` count fetches kicked off anywhere
 * (identity.ts, api.ts, …) without threading a context through every component.
 */

import { useEffect, useState } from "react";

let inFlight = 0;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

/**
 * Wrap a fetch so the warming machinery can see it's in flight. Increments on
 * start, decrements on settle (success or failure).
 */
export async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  inFlight += 1;
  notify();
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    if (inFlight < 0) inFlight = 0;
    notify();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe the backend's liveness endpoint. Resolves true if the server answered
 * within `timeoutMs` (warm), false if it didn't (cold/unreachable — the request
 * is sitting in the activator waiting for a pod). Any HTTP status counts as
 * "up": even a 5xx means the process is serving, which is all the cold-start
 * banner cares about. Cache-busted + no-store so an edge/CDN can't answer for a
 * server that's actually asleep.
 */
async function probeWarm(timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`/api/health/live?t=${Date.now()}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type WarmingOpts = {
  /** Don't probe until something has been in flight this long — avoids a probe
   *  on every fast call. This is just an "is anything actually slow yet" gate;
   *  the cold-vs-warm decision is the probe's, not this timer's. */
  softDelayMs?: number;
  /** How long the probe waits before declaring the server unreachable. */
  probeTimeoutMs?: number;
  /** While cold, re-probe this often until the pod wakes. */
  repollMs?: number;
};

/**
 * True only while a liveness probe confirms the backend isn't answering
 * promptly *and* something is still in flight. Flips off the moment the server
 * responds quickly or everything settles.
 */
export function useWarming(opts: WarmingOpts = {}): boolean {
  const { softDelayMs = 2500, probeTimeoutMs = 1500, repollMs = 4000 } = opts;
  const [warming, setWarming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;

    async function pollLoop() {
      if (polling) return;
      polling = true;
      // Keep probing while something is still slow in flight. Each probe both
      // decides the banner and (when cold) nudges Knative to scale up.
      while (!cancelled && inFlight > 0) {
        const warm = await probeWarm(probeTimeoutMs);
        if (cancelled) break;
        setWarming(!warm);
        if (warm) break; // warm: ordinary slow request — stop probing
        await sleep(repollMs); // cold: wait, then probe again until it wakes
      }
      if (!cancelled) setWarming(false);
      polling = false;
    }

    const evaluate = () => {
      if (inFlight > 0) {
        if (!softTimer && !polling) {
          softTimer = setTimeout(() => {
            softTimer = null;
            void pollLoop();
          }, softDelayMs);
        }
      } else {
        if (softTimer) {
          clearTimeout(softTimer);
          softTimer = null;
        }
        setWarming(false);
      }
    };

    subscribers.add(evaluate);
    evaluate();

    return () => {
      cancelled = true;
      subscribers.delete(evaluate);
      if (softTimer) clearTimeout(softTimer);
    };
  }, [softDelayMs, probeTimeoutMs, repollMs]);

  return warming;
}
