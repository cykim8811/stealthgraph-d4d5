# template-coders

[![Deploy on coders.kr](https://coders.kr/deploy-button.svg)](https://coders.kr/deploy?repo=https://github.com/cykim8811/template-coders)

A small starter app written for the [coders.kr](https://coders.kr)
platform. Hand a Claude Code session the link to this repo, ask it to
deploy, and you have a live site that:

- Lets anyone read a public feed.
- Lets signed-in visitors post.
- Maps each coders.kr visitor to a row in this app's own `users`
  table on first sight, without ever shipping an OAuth flow.

Use it as a base when you want to write something that lives natively
on coders.kr rather than retrofitting an existing app.

## What the platform gives you

When a request reaches this app, the platform has already done four
things:

1. Validated the visitor's `coders_session` cookie at the edge.
2. If it was valid, stamped the request with `X-Coders-User: <uuid>`.
3. If the request was a mutation (POST/PUT/PATCH/DELETE) and the
   visitor was anonymous, redirected them to the platform sign-in page
   *before* the request reached you.
4. Recorded the request against the right metering bucket
   (anonymous → `ProjectQuota`; signed-in → `UserProjectQuota`).

So inside your code:

- **Trust `X-Coders-User`.** The gate strips any inbound value from the
  client before forwarding, so a value you see here came from a real,
  validated session.
- **Don't build a sign-in flow.** Link to
  `https://mcp.coders.kr/sso/login?return_to=<your URL>` instead. Sign
  out is `https://mcp.coders.kr/sso/logout?return_to=…`.
- **Use POST for anything that needs identity.** The gate auto-gates
  anonymous mutations — you get a logged-in user every time.

## Code tour

```
backend/
  app/
    core/identity.py    require_identity / optional_identity dependencies
    routes/users.py     /api/me  — auto-upserts the local row on first sight
    routes/posts.py     /api/feed (public) + POST /api/posts (auth-required)
    models.py           User(id, coders_id, display_name) + Post(...)
frontend/
  lib/identity.ts       getCodersUser() reads the X-Coders-User header
  components/SignIn.tsx Sign in/out links that target the platform
  app/layout.tsx        shows the visitor's display_name once signed in
  app/page.tsx          feed + inline compose form for signed-in visitors
  app/profile/page.tsx  the visitor's profile + their posts
coders.yaml             web + api + postgres; `mode: native`
```

## Local development

**One command, full hot reload — no platform, no setup:**

```bash
docker compose up
```

Brings up Postgres + the FastAPI backend (`uvicorn --reload`) + the Next.js
frontend (`next dev`) at **http://localhost:3000**. Edit any file and it's live
instantly — no rebuild, no deploy. Iterate here; deploy only when you're ready
to ship. (`/api/*` is proxied to the backend, and Postgres migrations run on
start.)

There's no platform gate locally, so every request is treated as a fixed
signed-in dev user (`DEV_FAKE_USER`, defaulted in `compose.yaml`). To test as a
different user — or the anonymous path — set `DEV_FAKE_USER` in `backend/.env`
(copy `backend/.env.example`), or unset it.

Prefer running the services yourself (no Docker)? Point the backend at a local
Postgres and set the same vars in `backend/.env`:

```bash
# backend/.env
DATABASE_URL=postgresql+asyncpg://app:app@localhost:5432/app
DEV_FAKE_USER=00000000-0000-0000-0000-000000000001
```

## Preview your local app at a real `coders.kr` URL — `dev_up`

`docker compose up` is fast but local-only: a fake user, no real platform gate,
and a URL only you can open. When you want to see your *local, hot-reloading*
code at a real `https://<name>-dev.coders.kr` — **with no build and no deploy** —
open a **dev tunnel**. In Claude Code:

```
dev_up <name>
```

It returns an `frpc.toml` and a one-line command. Then, on your machine:

1. Run your app locally on port 3000 (`docker compose up` is fine).
2. Install [frp](https://github.com/fatedier/frp) (`brew install frpc`) and save
   the returned config as `frpc.toml`.
3. `frpc -c frpc.toml`
4. Open `https://<name>-dev.coders.kr`.

Now every edit on your machine is live at that URL instantly — the bytes are
served straight from your laptop (HMR/WebSockets included). Unlike pure-local
dev, requests go through the **real platform gate**: the preview is **private to
you** (owner-only), the session cookie is stripped, and your real
`X-Coders-User` is stamped — exactly like production, so you can test identity
for real. Your live `<name>.coders.kr` site is untouched.

Requires the project to have been `deploy`ed at least once (the tunnel reuses its
namespace). `dev_down <name>` closes the tunnel (it also auto-closes after a few
idle hours). Use this for the tight edit→see loop; `deploy` when you're ready to
ship for real.

## Deploying

This repo ships a [`.mcp.json`](./.mcp.json) that points Claude Code at the
coders.kr MCP server (`https://mcp.coders.kr/mcp`). The first time you open
the project, Claude Code asks you to approve the server and walks you through
a one-time browser sign-in — after that the deploy/manage tools are available
in the session. (No `claude mcp add` needed.)

Then, in Claude Code:

```
deploy https://github.com/<you>/<your-fork>
```

That's it. The platform reads `coders.yaml`, parallel-builds the two
images, brings up Postgres in your tenant namespace, wires
`${db.url}` into the backend's env, fronts the whole thing with a
gate at `<name>.coders.kr`, and returns the URL.

## Platform policies (read before you ship)

[**PLATFORM.md**](./PLATFORM.md) documents how the platform treats your app
at runtime — identity, the cost model, quota pools, cold start, and the
WebSocket/long-connection rules. **If your app streams or holds connections
open, read §5 first:** a single open *anonymous* WebSocket drains your
site's anonymous pool in under an hour, after which all anonymous traffic is
redirected to sign-in.

## Going further

- Add a `redis` component to `coders.yaml` if you want background jobs.
- Bump `coders.yaml`'s pool sizes (next-slice feature) once your app
  has clear cost characteristics.
- For apps that already have their own login flow and don't want to
  rewire identity, set `mode: standalone` instead — see
  [PLATFORM.md](https://github.com/cykim8811/coders-platform/blob/main/PLATFORM.md).
