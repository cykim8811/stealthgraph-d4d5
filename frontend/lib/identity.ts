"use client";

/**
 * Client-side identity helpers.
 *
 * The platform gate validates the visitor's `coders_session` cookie at
 * the edge and stamps `X-Coders-User` onto every request that reaches
 * the backend. A static SPA can't read that header (it's HTML, not a
 * server), so we discover identity by fetching `/api/me` and looking
 * at the response:
 *    200 → signed in (the gate forwarded the user, the backend echoed
 *          a row out of its own users table)
 *    401 → anonymous
 */

import { useEffect, useState } from "react";

import { tracked } from "./warming";

export type Me = {
  id: string;
  coders_id: string;
  display_name: string;
  first_seen_at: string;
};

// `undefined` = still loading; `null` = anonymous; Me = signed in.
export type MeState = Me | null | undefined;

export function useMe(): MeState {
  const [me, setMe] = useState<MeState>(undefined);
  useEffect(() => {
    let alive = true;
    tracked(async () => {
      const r = await fetch("/api/me", { credentials: "include" });
      if (!alive) return;
      if (r.ok) setMe(await r.json());
      else setMe(null);
    }).catch(() => {
      if (alive) setMe(null);
    });
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

function currentLocation(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}

function buildHref(path: string, returnTo?: string): string {
  const target = returnTo ?? currentLocation();
  const here =
    typeof window === "undefined" ? "" : window.location.origin;
  const absolute = target.startsWith("http") ? target : here + target;
  return `https://mcp.coders.kr${path}?return_to=${encodeURIComponent(absolute)}`;
}

export function signInHref(returnTo?: string): string {
  return buildHref("/sso/login", returnTo);
}

export function signOutHref(returnTo?: string): string {
  return buildHref("/sso/logout", returnTo);
}
