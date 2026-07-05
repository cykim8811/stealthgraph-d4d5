"use client";

import { useState } from "react";

/* Dev-only floating pill (think Next.js's corner dev indicator): a reminder
 * that the running app is one sentence away from being live. Renders nothing
 * in production builds — the NODE_ENV check is statically eliminated. */
export function DevDeployBadge() {
  const [open, setOpen] = useState(false);

  if (process.env.NODE_ENV !== "development") return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 font-sans">
      {open && (
        <div className="mb-2 w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl">
          <p className="text-[13px] font-semibold">Deploy this app</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-400">
            Tell Claude Code:
          </p>
          <pre className="mt-1.5 overflow-x-auto rounded-md bg-zinc-950 px-3 py-2 font-mono text-[12px] text-zinc-200">
            deploy this on coders.kr
          </pre>
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
            Already on GitHub? Swap{" "}
            <code className="text-zinc-300">github.com</code> for{" "}
            <code className="text-zinc-300">coders.kr</code> in the repo URL,
            or use{" "}
            <a
              href="https://coders.kr/deploy"
              target="_blank"
              rel="noreferrer"
              className="text-zinc-200 underline underline-offset-2"
            >
              coders.kr/deploy
            </a>
            .
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-zinc-100 shadow-lg transition-transform hover:scale-[1.03]"
      >
        <span aria-hidden>▲</span> Deploy on coders.kr
      </button>
    </div>
  );
}
