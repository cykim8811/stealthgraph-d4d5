"use client";

/**
 * Thin API client for the STEALTHGRAPH backend. Every call hits /api/* on
 * this origin; nginx proxies to the FastAPI service. Reads are public;
 * belief writes require a signed-in visitor (the platform gate enforces
 * it for PUT).
 */

import { tracked } from "./warming";

export type NodeType =
  | "handle"
  | "email"
  | "wallet"
  | "telegram"
  | "device"
  | "pgp"
  | "ip"
  | "forum"
  // StealthMole's own identifier categories (live mode) — the demo dataset
  // never emits these, but a live investigation pivots through them often.
  | "domain"
  | "url"
  // telegram-native anchors (live mode): the contact/redistribution keys a
  // covert operator reuses even after rotating handles and numeric UIDs.
  | "tox"
  | "hash"
  | "xmpp"
  | "invite";

export type GraphNode = {
  id: string;
  type: NodeType;
  label: string;
  anchor: boolean;
  sources: string[];
  meta: Record<string, string>;
  seed_hop: number;
  // live-mode reuse-breadth: module → total records seen for this identifier
  // (learned when queried), and the resulting rarity factor (1 = rare/strong
  // anchor, →0 = widely-traded/weak). Absent in demo mode.
  breadth?: Record<string, number>;
  reuse_factor?: number;
};

export type Contribution = {
  module: string;
  label: string;
  raw: number;
  source: string;
  note: string;
  frm: number | null;
  to: number | null;
  active: boolean;
  forgeability: number;
  eff_weight: number;
  llr: number;
  contrib: number;
};

export type GraphEdge = {
  a: string;
  b: string;
  p: number;
  p_ever: number;
  active: boolean;
  contested: boolean;
  contributions: Contribution[];
  // live-mode: min-endpoint rarity factor (1 = both endpoints rare → full
  // strength; →0 = a widely-traded identifier is shared → discounted). When
  // `discounted`, the raw evidence was pulled toward neutral because a shared
  // identifier turned out to be common inventory, not a unique anchor.
  rarity?: number;
  discounted?: boolean;
};

export type ModuleInfo = {
  key: string;
  label: string;
  weight: number;
  forgeability: number;
  eff_weight: number;
  description: string;
};

export type TimeBounds = {
  start: number;
  end: number;
  transfer: number;
  default: number;
};

export type Seed = { id: string; label: string; hint: string };

export type Meta = {
  seeds: Seed[];
  default_seed: string;
  modules: ModuleInfo[];
  time: TimeBounds;
  constants: {
    prior_logit: number;
    llr_scale: number;
    forge_discount: number;
  };
};

export type GraphResponse = {
  seed: string;
  asof: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  modules: ModuleInfo[];
  time: TimeBounds;
};

export type ModuleConfig = {
  disabled: Set<string>;
  weights: Record<string, number>;
};

function configParams(cfg: ModuleConfig): string {
  const parts: string[] = [];
  if (cfg.disabled.size) parts.push(`disabled=${[...cfg.disabled].join(",")}`);
  const w = Object.entries(cfg.weights)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  if (w) parts.push(`weights=${encodeURIComponent(w)}`);
  return parts.join("&");
}

export async function fetchMeta(): Promise<Meta> {
  return tracked(async () => {
    const r = await fetch("/api/meta", { credentials: "include" });
    if (!r.ok) throw new Error(`meta ${r.status}`);
    return r.json();
  });
}

export async function fetchGraph(
  seed: string,
  asof: number | null,
  cfg: ModuleConfig
): Promise<GraphResponse> {
  return tracked(async () => {
    const params = new URLSearchParams();
    params.set("seed", seed);
    if (asof != null) params.set("asof", String(Math.round(asof)));
    const extra = configParams(cfg);
    const qs = extra ? `${params.toString()}&${extra}` : params.toString();
    const r = await fetch(`/api/graph?${qs}`, { credentials: "include" });
    if (!r.ok) throw new Error(`graph ${r.status}`);
    return r.json();
  });
}

// --- belief store (best-effort DB sync; localStorage is source of truth) ---

export type BeliefBlob = {
  categories: { id: string; label: string; color: string }[];
  trustByCat: Record<string, string[]>;
  activeCats: string[];
};

export async function fetchBeliefs(): Promise<Record<string, BeliefBlob>> {
  try {
    const r = await fetch("/api/beliefs", { credentials: "include" });
    if (!r.ok) return {};
    const b = await r.json();
    return b.beliefs ?? {};
  } catch {
    return {};
  }
}

export async function putBelief(seed: string, data: BeliefBlob): Promise<void> {
  try {
    await fetch(`/api/beliefs/${encodeURIComponent(seed)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ data }),
    });
  } catch {
    /* offline-first: localStorage already holds the truth */
  }
}
