"use client";

import { Snowflake } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWarming } from "@/lib/warming";

/**
 * Top-of-page heads-up while any tracked fetch (lib/warming.ts) has been
 * in flight for ~5s — i.e. the api KSvc is cold-starting.
 *
 * Fixed-positioned over the layout so it never pushes the page content
 * down. Opacity transitions 0 → 75 so the banner reveals smoothly and
 * still lets the content underneath read through.
 *
 * `pointer-events-none` keeps clicks falling through to whatever is
 * below — purely decorative.
 *
 * Stays inert at SSR; only after hydration does the client-side
 * `useWarming` flip it on.
 */
export function WarmingBar() {
  const warming = useWarming();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!warming}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-40 border-b border-foreground/10 bg-background/40 backdrop-blur-xl backdrop-saturate-150 shadow-sm px-6 sm:px-8 py-2.5 text-[13px] text-foreground/80 transition-opacity duration-500",
        warming ? "opacity-100" : "opacity-0"
      )}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <Snowflake className="size-4 shrink-0 text-muted-foreground" />
        <span>
          <span className="font-medium">Warming up the server.</span>{" "}
          <span className="text-muted-foreground">
            This site idles between visits — first request takes ~30s while
            the backend wakes up.
          </span>
        </span>
      </div>
    </div>
  );
}
