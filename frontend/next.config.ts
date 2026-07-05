import type { NextConfig } from "next";

// In production the app is a fully static export (`out/`) served by nginx,
// which proxies /api/* to the backend (see frontend/nginx.conf.template).
// `next export` doesn't support rewrites, so we only enable them in dev —
// where `next dev` needs to forward /api/* to the backend itself.
const isDev = process.env.NODE_ENV === "development";
const backend = process.env.BACKEND_URL || "http://localhost:8000";

const nextConfig: NextConfig = {
  ...(isDev ? {} : { output: "export" }),
  trailingSlash: false,
  ...(isDev
    ? {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${backend}/api/:path*` },
          ];
        },
        // Docker Desktop's bind mount (VirtioFS/gRPC-FUSE on macOS) syncs
        // file content instantly but doesn't reliably forward inotify
        // change events into the container, so webpack's default
        // event-based watcher never fires and edits only show up after a
        // full container restart. Polling mtimes directly sidesteps that.
        // The WATCHPACK_POLLING env var (see compose.yaml) does the same
        // via a different path; this makes it explicit and unconditional.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        webpack(config: any) {
          config.watchOptions = { poll: 800, aggregateTimeout: 300 };
          return config;
        },
      }
    : {}),
};

export default nextConfig;
