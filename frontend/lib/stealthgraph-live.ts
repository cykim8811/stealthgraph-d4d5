"use client";

/**
 * Live StealthMole-backed investigation client. Same node/edge/module
 * shape as lib/stealthgraph.ts (so GraphCanvas/Inspector/trust logic are
 * reused verbatim) plus live-only fields: quotas, queryable identifiers,
 * and a fire log.
 *
 * Every call here maps to exactly one HTTP GET. /fire is the only one
 * that can spend real rate-limit budget — it must only ever be triggered
 * by an explicit user click, never by a debounced effect (see
 * StealthGraph.tsx's liveMode branch).
 */

import { tracked } from "./warming";
import type {
  Contribution,
  GraphEdge,
  GraphNode,
  ModuleInfo,
} from "./stealthgraph";

export type SmModule = {
  id: string;
  code: string;
  label: string;
  kind: string;
  accepts: string[];
};

export type QuotaEntry = { allowed: number; used: number };
export type Quotas = Record<string, QuotaEntry> | null;

export type QueryableEntry = {
  type: string;
  value: string;
  modules: { id: string; code: string; label: string }[];
};

export type FireLogEntry = {
  kind: "seed" | "fired" | "cached" | "ratelimited" | "quota" | "error" | "compared";
  module?: string;
  query?: string;
  total?: number;
  cost?: number;
  added?: number;
  note?: string;
};

export type LiveState = {
  seed: string | null;
  asof: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  modules: ModuleInfo[];
  queryable: Record<string, QueryableEntry>;
  fire_log: FireLogEntry[];
  last_fire: FireLogEntry | null;
  quotas: Quotas;
  configured: boolean;
};

export type LiveMeta = { modules: SmModule[]; configured: boolean };

const STORAGE_KEY = "stealthgraph.live.sessionId";

export function liveSessionId(): string {
  if (typeof window === "undefined") return "server";
  let sid = window.localStorage.getItem(STORAGE_KEY);
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(STORAGE_KEY, sid);
  }
  return sid;
}

async function get<T>(path: string): Promise<T> {
  return tracked(async () => {
    const r = await fetch(path, { credentials: "include" });
    if (!r.ok) {
      let detail = `요청 실패 (${r.status})`;
      try {
        const j = await r.json();
        if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch {
        /* non-JSON */
      }
      throw new Error(detail);
    }
    return r.json();
  });
}

export const fetchLiveMeta = () => get<LiveMeta>("/api/live/meta");

export const fetchLiveState = (disabled: Set<string>, weights: Record<string, number>) =>
  get<LiveState>(`/api/live/state?s=${liveSessionId()}${cfgParams(disabled, weights)}`);

export const seedLiveIdentifier = (query: string) =>
  get<LiveState>(`/api/live/seed?s=${liveSessionId()}&query=${encodeURIComponent(query)}`);

// The only call that can spend real StealthMole rate-limit budget —
// call this ONLY from a direct user click handler.
export const fireLiveModule = (
  moduleId: string,
  nodeId: string,
  disabled: Set<string>,
  weights: Record<string, number>
) =>
  get<LiveState>(
    `/api/live/fire?s=${liveSessionId()}&module=${moduleId}&node=${encodeURIComponent(nodeId)}${cfgParams(disabled, weights)}`
  );

// Adversarial verify an edge: drill both accounts and compare writing style.
// Emits a `stylometry` observation (negative if they diverge) onto the a–b edge.
export const compareLiveNodes = (
  a: string,
  b: string,
  disabled: Set<string>,
  weights: Record<string, number>
) =>
  get<LiveState>(
    `/api/live/compare?s=${liveSessionId()}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}${cfgParams(disabled, weights)}`
  );

export const resetLiveSession = () => get<LiveState>(`/api/live/reset?s=${liveSessionId()}`);

function cfgParams(disabled: Set<string>, weights: Record<string, number>): string {
  const parts: string[] = [];
  if (disabled.size) parts.push(`disabled=${[...disabled].join(",")}`);
  const w = Object.entries(weights).map(([k, v]) => `${k}:${v}`).join(",");
  if (w) parts.push(`weights=${encodeURIComponent(w)}`);
  return parts.length ? `&${parts.join("&")}` : "";
}

// ---- case persistence (durable work product) -----------------------------

export type Assessment = {
  bluf?: string;
  confidence?: string;
  recommendations?: string;
};

export type CaseSummary = {
  id: string;
  title: string;
  seed: string;
  nodes: number;
  updated_at: string;
};

export type CaseFull = {
  id: string;
  title: string;
  seed: string;
  assessment: Assessment;
  created_at: string;
  updated_at: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  fire_log: FireLogEntry[];
};

async function req<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = `요청 실패 (${r.status})`;
    try {
      const j = await r.json();
      if (j?.detail) detail = typeof j.detail === "string" ? j.detail : detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(detail);
  }
  return r.json();
}

export const saveCase = (title: string) =>
  req<{ id: string; title: string; seed: string }>("/api/live/cases", "POST", {
    s: liveSessionId(),
    title,
  });

export const listCases = () =>
  req<{ cases: CaseSummary[] }>("/api/live/cases", "GET").then((d) => d.cases);

export const getCase = (id: string) =>
  req<CaseFull>(`/api/live/cases/${id}`, "GET");

export const updateCase = (id: string, body: { title?: string; assessment?: Assessment }) =>
  req<{ ok: boolean }>(`/api/live/cases/${id}`, "PUT", body);

export const deleteCase = (id: string) =>
  req<{ ok: boolean }>(`/api/live/cases/${id}`, "DELETE");

export const openCase = (id: string) =>
  req<{ ok: boolean; seed: string }>(
    `/api/live/cases/${id}/open?s=${liveSessionId()}`,
    "POST"
  );

export type { Contribution };
