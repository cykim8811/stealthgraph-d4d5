"use client";

/**
 * Real-time force-directed graph on a <canvas>. Runs its own rAF sim loop
 * (charge repulsion + edge springs + gravity + friction with alpha
 * cooling) independent of React renders. Nodes drag springily; the
 * background pans; the wheel zooms.
 *
 * Rendering is data-driven by the trust view: node alpha = brightness,
 * anchors get a double ring, trusted nodes a green ✓ ring; edges are
 * violet when active (p ≥ θ), red when contested, faint otherwise.
 */

import { useCallback, useEffect, useRef } from "react";

import type { GraphEdge, GraphNode, NodeType } from "@/lib/stealthgraph";
import type { NodeView } from "@/lib/trust";

export const PALETTE: Record<NodeType, string> = {
  handle: "#6ea8fe",
  email: "#f5a97f",
  wallet: "#f2cd60",
  telegram: "#57c7ff",
  device: "#b48ef2",
  pgp: "#7ee0a1",
  ip: "#9aa5b8",
  forum: "#e084c4",
  domain: "#8fd4a8",
  url: "#c9b28a",
  tox: "#5be1c9",
  hash: "#8a94a6",
  xmpp: "#d9a066",
  invite: "#c98bf0",
};

// distinct hues for θ-clusters (virtual entities)
const CLUSTER_HUES = [265, 150, 30, 200, 330, 90, 0, 240];

// Screen-space drag threshold (px) — a click must move less than this to
// still register as a click; past it, it commits to a drag. Without this,
// the sub-pixel jitter every mouse produces between down and up either
// nudges the node (since drag pins it to the pointer immediately) or
// swallows the click (since any movement was treated as "dragged").
const DRAG_THRESHOLD = 4;

function nodeRadius(n: GraphNode, v: NodeView | undefined): number {
  return (n.anchor ? 8.5 : 6.5) + (v?.tier === "trusted" ? 1.5 : 0);
}

type P = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null; // pinned (during drag)
  fy: number | null;
};

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  views: Map<string, NodeView>;
  theta: number;
  selectedId: string | null;
  seedClusterId: number | null;
  onSelect: (id: string | null) => void;
};

export function GraphCanvas({
  nodes,
  edges,
  views,
  theta,
  selectedId,
  seedClusterId,
  onSelect,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pos = useRef<Map<string, P>>(new Map());
  const cam = useRef({ x: 0, y: 0, scale: 1 });
  const alpha = useRef(1);
  const size = useRef({ w: 800, h: 600 });
  const hover = useRef<string | null>(null);
  // cheap by-id lookup for edge-endpoint radius, rebuilt only when the
  // nodes array reference actually changes (not every animation frame)
  const nodesById = useRef<{ src: GraphNode[] | null; map: Map<string, GraphNode> }>({
    src: null,
    map: new Map(),
  });

  // latest props for the sim loop (avoid stale closures)
  const data = useRef<Props>({
    nodes,
    edges,
    views,
    theta,
    selectedId,
    seedClusterId,
    onSelect,
  });
  data.current = { nodes, edges, views, theta, selectedId, seedClusterId, onSelect };

  const reheat = useCallback((a = 0.6) => {
    alpha.current = Math.max(alpha.current, a);
  }, []);

  // seed positions for new nodes (ring around center)
  useEffect(() => {
    const { w, h } = size.current;
    const cx = w / 2;
    const cy = h / 2;
    let added = 0;
    nodes.forEach((n, i) => {
      if (!pos.current.has(n.id)) {
        const ang = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        const r = 120 + (i % 5) * 26;
        pos.current.set(n.id, {
          x: cx + Math.cos(ang) * r,
          y: cy + Math.sin(ang) * r,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null,
        });
        added++;
      }
    });
    // drop positions for removed nodes
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...pos.current.keys()]) {
      if (!ids.has(id)) pos.current.delete(id);
    }
    if (added) reheat(0.9);
  }, [nodes, reheat]);

  // reheat gently when the graph config changes (weights shift springs)
  useEffect(() => {
    reheat(0.4);
  }, [edges, theta, reheat]);

  // ---- sim + render loop ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const step = () => {
      const d = data.current;
      const P = pos.current;
      const a = alpha.current;

      if (a > 0.005) {
        const { w, h } = size.current;
        const cx = w / 2;
        const cy = h / 2;
        // repulsion (O(n^2), fine for ≤ ~80 nodes)
        for (const n1 of d.nodes) {
          const p1 = P.get(n1.id);
          if (!p1) continue; // position not seeded yet (node just added)
          for (const n2 of d.nodes) {
            if (n1.id >= n2.id) continue;
            const p2 = P.get(n2.id);
            if (!p2) continue;
            let dx = p1.x - p2.x;
            let dy = p1.y - p2.y;
            let dist2 = dx * dx + dy * dy;
            if (dist2 < 1) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              dist2 = 1;
            }
            const dist = Math.sqrt(dist2);
            const force = (3600 / dist2) * a;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            p1.vx += fx;
            p1.vy += fy;
            p2.vx -= fx;
            p2.vy -= fy;
          }
        }
        // springs
        for (const e of d.edges) {
          const p1 = P.get(e.a);
          const p2 = P.get(e.b);
          if (!p1 || !p2) continue;
          const rest = 66 + (1 - e.p) * 150;
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const k = (0.02 + 0.06 * e.p) * a;
          const disp = dist - rest;
          const fx = (dx / dist) * disp * k;
          const fy = (dy / dist) * disp * k;
          p1.vx += fx;
          p1.vy += fy;
          p2.vx -= fx;
          p2.vy -= fy;
        }
        // gravity + integrate
        for (const n of d.nodes) {
          const p = P.get(n.id);
          if (!p) continue; // position not seeded yet (node just added)
          if (p.fx != null) {
            p.x = p.fx;
            p.y = p.fy!;
            p.vx = 0;
            p.vy = 0;
            continue;
          }
          p.vx += (cx - p.x) * 0.0016 * a;
          p.vy += (cy - p.y) * 0.0016 * a;
          p.vx *= 0.86;
          p.vy *= 0.86;
          p.x += p.vx;
          p.y += p.vy;
        }
        alpha.current *= 0.992;
        if (alpha.current < 0.02) alpha.current = 0.02 * 0; // settle to 0
      }

      render(ctx);
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const render = (ctx: CanvasRenderingContext2D) => {
    const d = data.current;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const P = pos.current;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(cam.current.x, cam.current.y);
    ctx.scale(cam.current.scale, cam.current.scale);

    // ---- edges ----
    if (nodesById.current.src !== d.nodes) {
      nodesById.current = {
        src: d.nodes,
        map: new Map(d.nodes.map((n) => [n.id, n])),
      };
    }
    const nodeMap = nodesById.current.map;
    for (const e of d.edges) {
      const p1 = P.get(e.a);
      const p2 = P.get(e.b);
      if (!p1 || !p2) continue;
      const va = d.views.get(e.a);
      const vb = d.views.get(e.b);
      // "lit" whenever EITHER endpoint is already trusted — a connection
      // reaching OUT from identity should read as live, not just ones
      // fully inside it. Anything with neither endpoint trusted gets a
      // flat 0.01 opacity, full stop — no blending with p.
      const aTrusted = (va?.brightness ?? 0.2) >= 1;
      const bTrusted = (vb?.brightness ?? 0.2) >= 1;
      const eitherTrusted = aTrusted || bTrusted;
      const vis = eitherTrusted ? 1 : 0.01;
      let color: string;
      let width: number;
      let dash: number[] = [];
      const active = e.p >= d.theta;
      if (e.contested) {
        color = `rgba(240,85,107,${eitherTrusted ? (0.5 + 0.5 * (1 - e.p)) * vis : vis})`;
        width = 1.4 + 1.6 * (1 - e.p);
        dash = [5, 4];
      } else if (active) {
        color = `rgba(167,139,250,${eitherTrusted ? (0.5 + 0.5 * e.p) * vis : vis})`;
        width = eitherTrusted ? 1.5 : 0.5;
      } else {
        color = `rgba(150,160,185,${eitherTrusted ? (0.15 + 0.3 * e.p) * vis : vis})`;
        width = 0.6 + 1.1 * e.p;
      }
      // A link weakened by reuse-breadth (a widely-traded shared identifier)
      // gets an amber dotted treatment — visually "suspect, don't lean on
      // this" — distinct from red contested (disproven by negative evidence).
      if (e.discounted && !e.contested) {
        dash = [1.5, 3];
        if (eitherTrusted) color = `rgba(245,185,66,${(0.35 + 0.4 * e.p) * vis})`;
      }
      // Trim the line to each node's circle edge instead of its center —
      // otherwise every line vanishes under the node fill and looks like
      // it's floating between centers rather than actually connecting.
      const na = nodeMap.get(e.a);
      const nb = nodeMap.get(e.b);
      const rA = na ? nodeRadius(na, va) : 0;
      const rB = nb ? nodeRadius(nb, vb) : 0;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const sx = p1.x + ux * rA;
      const sy = p1.y + uy * rA;
      const ex = p2.x - ux * rB;
      const ey = p2.y - uy * rB;

      ctx.beginPath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ---- nodes ----
    for (const n of d.nodes) {
      const p = P.get(n.id);
      if (!p) continue; // position not seeded yet (node just added)
      const v = d.views.get(n.id);
      const b = v?.brightness ?? 0.4;
      const base = PALETTE[n.type] ?? "#9aa5b8";
      const r = nodeRadius(n, v);
      const isSel = n.id === d.selectedId;
      const isHover = n.id === hover.current;

      // cluster halo when this node is in the seed's virtual entity
      if (
        d.seedClusterId != null &&
        v &&
        v.cluster === d.seedClusterId &&
        v.tier !== "hidden"
      ) {
        const hue = CLUSTER_HUES[v.cluster % CLUSTER_HUES.length];
        ctx.beginPath();
        ctx.fillStyle = `hsla(${hue},70%,60%,${0.08 * (0.5 + b)})`;
        ctx.arc(p.x, p.y, r + 10, 0, Math.PI * 2);
        ctx.fill();
      }

      // selection / hover ring
      if (isSel || isHover) {
        ctx.beginPath();
        ctx.strokeStyle = isSel ? "#e8ecf4" : "rgba(232,236,244,0.4)";
        ctx.lineWidth = isSel ? 2 : 1.2;
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // anchor: outer ring
      if (n.anchor) {
        ctx.beginPath();
        ctx.strokeStyle = withAlpha(base, 0.55 * b);
        ctx.lineWidth = 1.5;
        ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // traded-inventory marker: an identifier proven to be a widely-reused
      // credential (low reuse_factor, learned from a CB/CDS breadth query)
      // gets an amber dashed ring — "this is common stolen inventory, a weak
      // identity anchor," the visual counterpart to its discounted edges.
      if (n.reuse_factor != null && n.reuse_factor < 0.6) {
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = `rgba(245,185,66,${0.5 + 0.4 * b})`;
        ctx.lineWidth = 1.5;
        ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // body — b is a flat 1.0 (trusted) or 0.2 (not yet trusted)
      ctx.beginPath();
      ctx.fillStyle = withAlpha(base, b);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      // trusted ✓ ring (green)
      if (v && v.trustedCats.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(52,211,153,${0.85})`;
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // label
      const showLabel =
        v?.tier === "trusted" ||
        v?.tier === "frontier" ||
        isSel ||
        isHover;
      if (showLabel) {
        ctx.font =
          "500 11px var(--font-jetbrains-mono, monospace), monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = `rgba(232,236,244,${Math.min(1, 0.45 + 0.55 * b)})`;
        ctx.fillText(n.label, p.x, p.y + r + 4);
      }
    }
    ctx.restore();
  };

  // ---- interaction ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;

    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      size.current = { w: rect.width, h: rect.height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    });
    ro.observe(wrap);

    const toWorld = (sx: number, sy: number) => {
      const c = cam.current;
      return { x: (sx - c.x) / c.scale, y: (sy - c.y) / c.scale };
    };

    const pick = (sx: number, sy: number): string | null => {
      const wpt = toWorld(sx, sy);
      let hit: string | null = null;
      let bestD = 16;
      for (const n of data.current.nodes) {
        const p = pos.current.get(n.id);
        if (!p) continue;
        const dx = p.x - wpt.x;
        const dy = p.y - wpt.y;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < bestD) {
          bestD = dd;
          hit = n.id;
        }
      }
      return hit;
    };

    let dragNode: string | null = null;
    let panning = false;
    let moved = false;
    // becomes true only once the pointer has moved past DRAG_THRESHOLD
    // since pointerdown — before that, downNode/downPan are pending but
    // nothing is pinned yet, so a plain click never nudges the node.
    let committed = false;
    let last = { x: 0, y: 0 };
    let downPos = { x: 0, y: 0 };

    const relPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = relPos(e);
      const hitId = pick(x, y);
      moved = false;
      committed = false;
      downPos = { x, y };
      last = { x, y };
      if (hitId) {
        dragNode = hitId;
        // deliberately NOT pinning fx/fy yet — see `committed` above.
      } else {
        panning = true;
      }
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const { x, y } = relPos(e);
      const hitId = pick(x, y);
      hover.current = hitId;
      canvas.style.cursor = hitId ? "pointer" : panning ? "grabbing" : "grab";

      if (!dragNode && !panning) return;

      if (!committed) {
        const dist = Math.hypot(x - downPos.x, y - downPos.y);
        if (dist < DRAG_THRESHOLD) return; // still within click tolerance
        committed = true;
        moved = true;
        if (dragNode) {
          // first frame past the threshold: pin at its CURRENT position,
          // not the pointer's, so there's no jump when dragging begins.
          const p = pos.current.get(dragNode)!;
          p.fx = p.x;
          p.fy = p.y;
        }
      }

      if (dragNode) {
        const wpt = toWorld(x, y);
        const p = pos.current.get(dragNode)!;
        p.fx = wpt.x;
        p.fy = wpt.y;
        reheat(0.5);
      } else if (panning) {
        cam.current.x += x - last.x;
        cam.current.y += y - last.y;
      }
      last = { x, y };
    };

    const onUp = (e: PointerEvent) => {
      const { x, y } = relPos(e);
      if (dragNode) {
        const p = pos.current.get(dragNode)!;
        p.fx = null;
        p.fy = null;
        if (!moved) data.current.onSelect(dragNode);
        reheat(0.3);
      } else if (panning && !moved) {
        data.current.onSelect(pick(x, y)); // click empty → deselect
      }
      dragNode = null;
      panning = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const c = cam.current;
      const factor = Math.exp(-e.deltaY * 0.0012);
      const ns = Math.min(3, Math.max(0.3, c.scale * factor));
      // zoom toward cursor
      c.x = mx - ((mx - c.x) * ns) / c.scale;
      c.y = my - ((my - c.y) * ns) / c.scale;
      c.scale = ns;
    };

    // Arrow-key spatial navigation: move selection to the nearest node in
    // the pressed direction, using each node's current (settled) world
    // position from the force sim. A "cone" (±55°) keeps a diagonal
    // neighbor from stealing e.g. an ArrowDown press just for being close.
    const DIRS: Record<string, { x: number; y: number }> = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
    };
    const CONE_COS = Math.cos((55 * Math.PI) / 180);

    const onKeyDown = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      if (!dir) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();

      const d = data.current;
      const P = pos.current;
      let originId = d.selectedId;
      if (!originId || !P.has(originId)) {
        // nothing selected yet — start from the exploration seed.
        originId = d.nodes.find((n) => n.seed_hop === 0)?.id ?? d.nodes[0]?.id ?? null;
        if (originId) {
          d.onSelect(originId);
          return; // first press just selects the seed; the next one navigates
        }
        return;
      }
      const origin = P.get(originId);
      if (!origin) return;

      let bestId: string | null = null;
      let bestScore = Infinity;
      for (const n of d.nodes) {
        if (n.id === originId) continue;
        const p = P.get(n.id);
        if (!p) continue;
        const dx = p.x - origin.x;
        const dy = p.y - origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) continue;
        const cosTheta = (dx * dir.x + dy * dir.y) / dist;
        if (cosTheta < CONE_COS) continue; // outside the directional cone
        // favor close AND well-aligned candidates over merely close ones
        const score = dist / cosTheta;
        if (score < bestScore) {
          bestScore = score;
          bestId = n.id;
        }
      }
      if (bestId) d.onSelect(bestId);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [reheat]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
    </div>
  );
}

function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
