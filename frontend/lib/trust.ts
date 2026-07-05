"use client";

/**
 * Active-exploration model: trust distance, tiers, brightness, and the
 * θ-thresholded "virtual entity" clusters. All pure functions over a
 * graph snapshot — no React, no I/O.
 *
 * Identity = seed + every node the analyst has trusted (in an active
 * hypothesis). Tiers radiate out from that identity by hop distance;
 * a node's brightness = its tier × the confidence of its weakest link
 * back to identity (so a link weakening over time dims the node too).
 */

import type { BeliefBlob, GraphEdge, GraphNode } from "./stealthgraph";

export const STORAGE_KEY = "stealthgraph.trust.v3";
export const REACH_FLOOR = 0.15; // an edge must clear this to carry trust

export type Tier = "trusted" | "frontier" | "preview" | "hidden";

export type NodeView = {
  hop: number; // graph distance from identity (Infinity = unreachable now)
  tier: Tier;
  bottleneck: number; // widest-path min edge p back to identity (0..1)
  brightness: number; // 0..1 render alpha
  cluster: number; // θ-component id
  trustedCats: string[]; // hypotheses this node is trusted in
  via: string | null; // the ONE neighbor this node's widest path back to
  // identity actually goes through (Dijkstra/Prim-style parent pointer) —
  // null for roots themselves, or for a node the search never reached.
};

export type TrustState = Record<string, BeliefBlob>; // keyed by seed

// ---- storage ----

export function loadTrust(): TrustState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TrustState) : {};
  } catch {
    return {};
  }
}

export function saveTrust(state: TrustState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / privacy mode — non-fatal */
  }
}

export function emptyBlob(): BeliefBlob {
  return { categories: [], trustByCat: {}, activeCats: [] };
}

export function uid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch {
    /* fall through */
  }
  return Math.abs(hashStr(String(performance.now()) + ":" + Math.floor(1e6)))
    .toString(36)
    .slice(0, 8);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ---- derived trust view ----

type Adj = Map<string, { to: string; p: number }[]>;

function buildAdj(nodes: GraphNode[], edges: GraphEdge[]): Adj {
  const adj: Adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (e.p < REACH_FLOOR) continue;
    adj.get(e.a)?.push({ to: e.b, p: e.p });
    adj.get(e.b)?.push({ to: e.a, p: e.p });
  }
  return adj;
}

function tierOf(hop: number): Tier {
  if (hop === 0) return "trusted";
  if (hop === 1) return "frontier";
  if (hop <= 4) return "preview";
  return "hidden";
}

/**
 * Connected components over edges with p ≥ θ. Each component is a
 * "virtual entity" at that threshold — no merge is stored, it's computed.
 */
export function clustersAtTheta(
  nodes: GraphNode[],
  edges: GraphEdge[],
  theta: number
): Map<string, number> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) {
    if (e.p < theta) continue;
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const rootIdx = new Map<string, number>();
  const out = new Map<string, number>();
  let next = 0;
  for (const n of nodes) {
    const r = find(n.id);
    if (!rootIdx.has(r)) rootIdx.set(r, next++);
    out.set(n.id, rootIdx.get(r)!);
  }
  return out;
}

/**
 * roots = seed + trusted nodes across the active hypotheses. Compute
 * hop distance (BFS) and widest-path bottleneck (maximin) from roots.
 */
export function computeViews(
  nodes: GraphNode[],
  edges: GraphEdge[],
  roots: Set<string>,
  theta: number,
  trustByCatActive: Record<string, string[]>
): Map<string, NodeView> {
  const adj = buildAdj(nodes, edges);
  const clusters = clustersAtTheta(nodes, edges, theta);

  // BFS hop distance from all roots.
  const hop = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    if (adj.has(r)) {
      hop.set(r, 0);
      queue.push(r);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const h = hop.get(cur)!;
    for (const { to } of adj.get(cur) ?? []) {
      if (!hop.has(to)) {
        hop.set(to, h + 1);
        queue.push(to);
      }
    }
  }

  // Widest path (maximin bottleneck) from roots — small graph, O(V·E).
  // `via` tracks the parent pointer for that best path (Prim-style), so the
  // UI can trace "which single neighbor is this node's strongest link back
  // to identity" rather than just knowing the bottleneck's magnitude.
  const best = new Map<string, number>();
  const via = new Map<string, string | null>();
  for (const r of roots) if (adj.has(r)) { best.set(r, 1); via.set(r, null); }
  const pq: string[] = [...roots].filter((r) => adj.has(r));
  while (pq.length) {
    // pick the frontier node with the highest bottleneck so far
    let bi = 0;
    for (let i = 1; i < pq.length; i++) {
      if ((best.get(pq[i]) ?? 0) > (best.get(pq[bi]) ?? 0)) bi = i;
    }
    const cur = pq.splice(bi, 1)[0];
    const cb = best.get(cur) ?? 0;
    for (const { to, p } of adj.get(cur) ?? []) {
      const cand = Math.min(cb, p);
      if (cand > (best.get(to) ?? 0)) {
        best.set(to, cand);
        via.set(to, cur);
        pq.push(to);
      }
    }
  }

  // which hypotheses trust each node
  const catsOf = new Map<string, string[]>();
  for (const [cat, ids] of Object.entries(trustByCatActive)) {
    for (const id of ids) {
      if (!catsOf.has(id)) catsOf.set(id, []);
      catsOf.get(id)!.push(cat);
    }
  }

  const out = new Map<string, NodeView>();
  for (const n of nodes) {
    const h = hop.get(n.id) ?? Infinity;
    const tier = tierOf(h === Infinity ? 99 : h);
    const bottleneck = roots.has(n.id) ? 1 : best.get(n.id) ?? 0;
    // Flat two-level brightness: identity (trusted) is fully lit; every
    // not-yet-trusted node/edge (frontier/preview/hidden alike) sits at a
    // single dim opacity so trust — not graph distance — reads as "lit up".
    const brightness = tier === "trusted" ? 1.0 : 0.2;
    out.set(n.id, {
      hop: h,
      tier,
      bottleneck,
      brightness,
      cluster: clusters.get(n.id) ?? -1,
      trustedCats: catsOf.get(n.id) ?? [],
      via: via.get(n.id) ?? null,
    });
  }
  return out;
}

/** Union of trusted-node ids over the active hypotheses (+ seed). */
export function rootsFrom(blob: BeliefBlob, seed: string): Set<string> {
  const roots = new Set<string>([seed]);
  const active = new Set(blob.activeCats);
  for (const [cat, ids] of Object.entries(blob.trustByCat)) {
    if (!active.has(cat)) continue;
    for (const id of ids) roots.add(id);
  }
  return roots;
}

export function activeTrustByCat(blob: BeliefBlob): Record<string, string[]> {
  const active = new Set(blob.activeCats);
  const out: Record<string, string[]> = {};
  for (const [cat, ids] of Object.entries(blob.trustByCat)) {
    if (active.has(cat)) out[cat] = ids;
  }
  return out;
}
