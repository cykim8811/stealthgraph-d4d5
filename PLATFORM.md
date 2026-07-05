# Platform policies you must understand

This is the detail behind the short list in the [README](./README.md). It
describes exactly how coders.kr treats your app at runtime — identity,
metering, quotas, and (the part that bites people) long-lived connections
like WebSockets. Read the WebSocket section before you ship anything that
streams.

> These are *platform* behaviours, not template code. They apply to any
> app running in `mode: native` on coders.kr, template-coders or not.

---

## 1. Identity & the gate

Every tenant runs behind a per-site **gate** (a reverse proxy the platform
puts in front of your public service). Before a request reaches your code
the gate has already:

1. Read and verified the visitor's `coders_session` cookie at the edge.
2. **Stripped** any client-supplied `X-Coders-User` header (so it can't be
   spoofed), then **set** `X-Coders-User: <uuid>` if the session was valid.
3. Decided, by HTTP method, whether an anonymous visitor is even allowed
   through (see §2).
4. Metered the request against the right quota bucket (see §3–4).

In your code:

- **Trust `X-Coders-User`.** If it's present, it's a real validated visitor.
  If it's absent, the visitor is anonymous.
- **Never build your own OAuth.** Link to
  `https://mcp.coders.kr/sso/login?return_to=<your-url>` to sign in and
  `https://mcp.coders.kr/sso/logout?return_to=<your-url>` to sign out.
- The visitor UUID is **pairwise per project** — the same person has a
  different `X-Coders-User` on a different site. Use it as a stable local
  key (`coders_id`), not as a global identity.

---

## 2. Method gating (native mode)

The gate treats HTTP methods as a read/write convention:

| Method | Anonymous visitor |
|---|---|
| `GET` / `HEAD` / `OPTIONS` (safe) | allowed through (metered) |
| `POST` / `PUT` / `PATCH` / `DELETE` | **302 → sign-in page** before reaching you |

So in native mode you get "reads are public, writes require a logged-in
user" for free — **use `POST` for anything that needs identity** and you'll
always have an `X-Coders-User` when the handler runs.

This is a *convenience*, not your security boundary. The real authorization
still happens in your app/DB (the gate only knows the HTTP method, not what
your handler does). Check `X-Coders-User` yourself before any sensitive
action.

---

## 3. The cost model (how a request is priced)

Every request that reaches your app costs **cost-units (micros)**, deducted
from one quota pool. The formula (per request):

```
cost = 100  +  ( duration_ms × 1  +  (response_bytes ÷ 1024) × 10 )  ÷  concurrency
        ^BASE         ^1 micro per ms        ^10 micros per KB out      ^in-flight requests
```

- **BASE = 100** micros — fixed per-request overhead.
- **+1 micro per millisecond** the request is open. This is the big one for
  anything slow or streaming.
- **+10 micros per KB** of response body.
- **÷ concurrency** — the variable part is divided by how many requests the
  pod is serving at that instant (pod-time is what the platform actually
  pays for, so 100 concurrent requests don't bill 100× a single one).

Rules of thumb:

- A snappy JSON `GET` (~50 ms, a few KB) ≈ **~200 micros**.
- A 1-second request ≈ **~1,100 micros**.
- **A held *HTTP* request (long-poll/SSE) open for 60 seconds ≈ ~60,000
  micros** (see §5b — this is why long-poll/SSE need care; a WebSocket is
  billed by egress, not open-time, so an idle one is ~free).

Static assets (JS/CSS/images) served with cache headers are fronted by
Cloudflare and **don't hit your pod**, so they cost nothing. Lean on the CDN.

---

## 4. Quota pools & what happens when one empties

The gate routes each request to one pool, in this order:

| Visitor | Pool | Default size | When it empties |
|---|---|---|---|
| **Anonymous** | `ProjectQuota` (one per *site*, per month) | **3,000,000** micros | **every anonymous request → 302 sign-in** ("sign in to keep browsing") |
| **Signed-in (not you)** | `UserProjectQuota` (per *visitor × site*, per month) | **300,000** micros | then falls through to ↓ |
| **Signed-in, paid** | `UserQuota` (per *visitor*, paid balance) | 0 until they top up | **gated page** ("upgrade your coders.kr subscription") |
| **You, the owner** | — exempt — | unlimited, unmetered | never |

Two consequences worth internalizing:

- **When your site's anonymous pool runs out, *all anonymous traffic* is
  redirected to sign-in for the rest of the month.** That's intended (it
  pushes heavy anonymous use toward an identified, separately-budgeted
  user) — but it means a single runaway cost source can effectively wall
  off your whole public site. Watch what anonymous visitors can make
  expensive.
- The signed-in **per-site pool is only 300,000 micros** — small. A normal
  app (short requests) is fine for thousands of requests; a streaming app
  burns it in minutes (see §5).

You, deploying your own site, are never metered — so **everything feels free
while you test.** Cost only shows up with real anonymous/other-user traffic.

---

## 5. WebSockets, SSE & long-lived connections — read this

WebSockets work through the gate, but the runtime is a scale-to-zero,
Spot-node, rolling-deploy platform, and the cost model prices by time. Three
things follow.

### 5a. Raise `timeout`, but expect disconnects anyway

Knative treats a WebSocket (or SSE / long-poll) as **one long-lived
request**, capped by the service's request timeout — **default 300 s**. For
realtime apps, set `timeout` (seconds, up to 3600) on every service the
socket passes through in `coders.yaml`:

```yaml
services:
  web:
    ...
    timeout: 3600   # if the socket terminates here
  api:
    ...
    timeout: 3600   # and/or here
```

But **connections are not durable regardless of `timeout`.** Spot-node
preemption, a redeploy rolling the revision, and idle scale-down all drop
open sockets. **Implement client reconnect with backoff** and resume state
on reconnect — treat a dropped socket as normal, not exceptional. (App-level
WebSocket ping/pong passes through the gate transparently and helps keep
intermediaries from closing an otherwise-quiet connection.)

### 5b. How long-lived connections are billed — WebSocket vs long-poll/SSE

Two **different** cost models, and the gap is large:

- **WebSocket (an upgraded connection): billed by egress bytes only — NOT by
  how long it stays open.** An *idle* socket costs ≈ **nothing**; an active
  stream costs roughly its bytes out. So holding a WebSocket open is cheap.
  (Open-*time* billing was removed after it drained sites' pools.)
- **long-poll / SSE (a held *HTTP* request, no upgrade): billed by open
  time**, ~**1 micro/ms ≈ 60,000 micros/min** (÷ concurrency), booked when
  the request closes. Against the §4 pools:

  | Pool | Size | ≈ minutes of one held long-poll/SSE request |
  |---|---|---|
  | Anonymous (whole site) | 3,000,000 | ~50 min |
  | Signed-in per-site | 300,000 | ~5 min |

  A held HTTP stream is the expensive one — and Cloudflare also severs it at
  ~50s regardless of `timeout` (§5d).

Design around it:

- **Prefer a WebSocket** for any persistent channel — it's idle-cheap and
  isn't subject to the ~50s Cloudflare cut.
- **Keep long-poll/SSE short** — return within ~50s and have the client
  re-poll (both because of the time billing and the CF limit).
- A background **daemon/agent** holding a connection open should still
  authenticate so its traffic is attributed to a real identity — send the
  `coders_session` cookie, or use a **runner token** (`Authorization: Bearer`)
  that resolves to you (the owner). An *anonymous* held long-poll/SSE keeps
  draining the shared anonymous pool.

### 5c. The gate can't see inside a socket — authorize messages yourself

The method gate (§2) only applies to the HTTP handshake, which is a `GET`.
Once the socket is open, the gate sees no individual messages, so it can't
enforce read/write rules on them. The gate **does** stamp `X-Coders-User` on
the handshake (empty if anonymous). **Authorize every state-changing message
in your own handler** against that identity — the platform won't do it for
you on a socket.

---

## 6. Cold start

Tenant services **scale to zero** when idle, so the first request after a
quiet period pays a cold start. Keep it short:

- **Build at image-build time, not container-start time.** Don't run
  `npm install` / `pip install` / migrations in your entrypoint — bake them
  into the Docker image. A slow entrypoint turns every cold start into a
  multi-second stall (and can trip readiness).
- Run DB migrations as a one-shot step, not on every boot.

(An open WebSocket keeps the pod warm — good for latency, and since
WebSockets are billed by egress not open-time (§5b), an idle one is cheap
to hold. A held long-poll/SSE request is the costly kind — see §5b.)

While iterating you can skip both builds and cold starts: `dev_up <name>`
opens a tunnel so `https://<name>-dev.coders.kr` serves your local,
hot-reloading code through the real gate (owner-only). See the README's
"Preview your local app at a real `coders.kr` URL".

---

## 7. Modes

- **`mode: native`** (this template): the gate does identity + method gating
  as above. Zero auth code in your app; trust `X-Coders-User`.
- **`mode: standalone`**: the gate touches neither identity nor method —
  all traffic counts against the anonymous pool and your app brings its own
  login. Use only if you're porting an app that already has OAuth. See the
  platform's [PLATFORM.md](https://github.com/cykim8811/coders-platform/blob/main/PLATFORM.md).

---

## 8. Managed LLM (Claude) — no API key of your own

Declare a `type: llm` component and the platform gives you a working Claude
endpoint with **no Anthropic key of your own**. The platform injects its key,
and **bills each call's exact tokens to the visitor's pool** — same per-visitor
economics as everything else.

```yaml
# coders.yaml
services:
  api:
    dockerfile: backend/Dockerfile
    env:
      ANTHROPIC_BASE_URL: ${ai.url}     # the platform LLM proxy
      ANTHROPIC_API_KEY:  ${ai.token}   # per-tenant token — NOT a real key

  ai:
    type: llm
    # Allow-list. Default is the cheaper tier; list Opus to opt in.
    models: [claude-sonnet-4-6, claude-haiku-4-5]
    default_model: claude-sonnet-4-6
```

Use the **stock Anthropic SDK** unchanged — only `base_url`/`api_key` come from
env. Streaming, tools, thinking, and prompt caching all pass through.

### You MUST forward `X-Coders-User` on each call

The proxy bills the **visitor**, but your server-side LLM call doesn't carry the
visitor's identity unless you pass it. Forward the `X-Coders-User` header you
received on the incoming request as `x-coders-user` on the Anthropic call.
**If you don't, the call is billed to the project's anonymous pool** (and one
chat can drain it — see below).

```python
# backend: forward the caller's identity so cost lands on THEIR pool
from anthropic import AsyncAnthropic
client = AsyncAnthropic()  # base_url + api_key from env

async def reply(prompt: str, coders_user):           # coders_user from identity dep
    msg = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
        extra_headers={"x-coders-user": str(coders_user)} if coders_user else {},
    )
    return msg.content[0].text
```

### Cost reality

LLM tokens are **far** more expensive than page compute. One Sonnet turn
(~1K in + 1K out) ≈ 21,600 micros — so the $3 anonymous pool buys only ~140
turns, the $0.30 per-user-per-site pool ~6. This is by design: the per-visitor
pool is what bounds spend. Plan for it — gate expensive generation behind
sign-in, keep prompts/outputs tight, and lean on prompt caching (cache-reads
are billed at 1/10th). The proxy clamps `max_tokens` to 16,000 per request.

---

## 9. `coders.yaml` is a strict contract — exact fields only

The platform validates your `coders.yaml` against a fixed schema and
**rejects any key it doesn't recognise**. A typo or a field from some
other tool's config (`build:`, `public:`, `scale:`, `resources:`,
`needs:`, `release:`, `health:`, `version:` on a service, …) **fails the
deploy** with the offending field named — it is not silently ignored. If
a deploy errors with `Extra inputs are not permitted`, delete that key.

The complete accepted shape (everything else is an error):

```yaml
version: "1"            # optional, default "1"
mode: native            # optional: native | standalone (default native)

services:               # required, ≥1 entry; each is a build OR a component
  <name>:               # ---- buildable service ----
    dockerfile: path/to/Dockerfile   # required (relative to repo root)
    context: .                       # optional, default "."
    port: 8080                       # optional, default 8080
    expose: internal                 # optional: public | internal (default internal)
    timeout: 300                     # optional seconds, 1–3600 (default 300)
    env:                             # optional, ${...}-substituted
      KEY: value

  <name>:                            # ---- managed component (no build) ----
    type: postgres                   # exposes ${<name>.host/port/user/password/name/url}
    size: 1Gi                        #   optional, 512Mi–10Gi (advisory)
  <name>:
    type: redis                      # exposes ${<name>.host/port/url}
  <name>:
    type: object                     # exposes ${<name>.bucket/region/endpoint/public_url}
    quota_gb: 1                      #   optional, 1–50
  <name>:
    type: llm                        # exposes ${<name>.url/token} — see §8
    models: [claude-sonnet-4-6, claude-haiku-4-5]   # optional allow-list
    default_model: claude-sonnet-4-6                # optional, must be in models
```

Cross-field rules the validator also enforces:

- **Exactly one** buildable service may set `expose: public` (that's your
  site at `<project>.coders.kr`).
- **At most one** `object` component and **at most one** `llm` component.

The canonical machine-readable schema lives at
[`schema/coders.schema.json`](https://github.com/cykim8811/coders-platform/blob/main/schema/coders.schema.json)
in the platform repo (point your editor's YAML LSP at it for inline
validation), and a worked example is at
[`examples/coders.yaml`](https://github.com/cykim8811/coders-platform/blob/main/examples/coders.yaml).

### `PORT` is injected and overrides your image

The platform injects `PORT=<the service's `port`>` into the container at
runtime, and it **overrides any `ENV PORT` baked into your image**. For a
normal single-process service that's exactly what you want — listen on
`$PORT` (or just the `port` you declared) and you're done.

It bites a **multi-process** container — one running an in-pod reverse proxy
or sidecar (e.g. nginx fronting a Next.js server, because only one service
may be `expose: public` and Next.js can't proxy WebSockets). If your app
server reads `PORT`, the injected value (= the public `port`, e.g. `80`)
makes it try to bind the port the proxy already owns → it dies with
`EADDRINUSE` and every request 502s even though `status()` says `ready`.

Pattern: let the proxy own the declared `port`, and **pin your app to a
different internal port in the entrypoint** — don't rely on `ENV PORT`, the
injection beats it:

```sh
# entrypoint.sh — nginx owns :80 (the declared port), app on :3000
PORT=3000 node server.js &      # force the app OFF the injected PORT
exec nginx -g 'daemon off;'     # nginx :80 routes /ws → app, rest → app
```

### Secrets & config values — use `set_env`, not a `secrets:` key

There is **no `secrets:` field** in `coders.yaml` (the schema above rejects
it). To give the app a value you don't want in the repo — an API key, a
client secret — set it out of band and redeploy:

```
set_env('<name>', 'STRIPE_SECRET', 'sk_live_…', secret=True)
deploy(...)        # roll a new revision that picks it up
```

The value is injected into **every service's** container env as
`STRIPE_SECRET`, and is also referenceable from `coders.yaml` as
`${secrets.STRIPE_SECRET}`. A `coders.yaml` `env:` entry with the same key
wins over it.

### Object storage — reads via the proxy, writes via S3/HMAC

A `type: object` component gives you a private per-tenant GCS bucket. It
exposes these substitutions:

| Reference                  | Use                                                    |
|----------------------------|--------------------------------------------------------|
| `${<name>.bucket}`         | bucket name                                            |
| `${<name>.region}`         | bucket region                                          |
| `${<name>.public_url}`     | **read** prefix — `https://<proj>.coders.kr/__storage`; serve files by building `f"{public_url}/{key}"` |
| `${<name>.s3_endpoint}`    | S3-compatible endpoint (`https://storage.googleapis.com`) |
| `${<name>.access_key}` / `${<name>.secret_key}` | S3/HMAC credentials for authenticated **writes** |

**Reads go through `${...public_url}`** (the gate's `/__storage/*` proxy —
cached + metered). **Writes** use the S3 API with the HMAC pair, so an
existing boto3 / aws-sdk app works with no rewrite:

```python
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["STORAGE_S3_ENDPOINT"],         # ${bucket.s3_endpoint}
    aws_access_key_id=os.environ["STORAGE_ACCESS_KEY"],     # ${bucket.access_key}
    aws_secret_access_key=os.environ["STORAGE_SECRET_KEY"], # ${bucket.secret_key}
    region_name="auto",
    # boto3 >= 1.36 adds request checksums GCS's S3 API rejects
    # (SignatureDoesNotMatch). Turn them off for GCS interop:
    config=Config(request_checksum_calculation="when_required",
                  response_checksum_validation="when_required"),
)
s3.put_object(Bucket=os.environ["STORAGE_BUCKET"], Key="u/123/avatar.png", Body=data)
```

The HMAC credentials are **write+overwrite only — they cannot read or
list** (that's deliberate: it keeps every download on the metered proxy).
So `GetObject`/`ListObjects` over S3 will 403 — read through `public_url`
instead. Presigned-URL downloads won't work; serve reads via the proxy.

---

## 10. Push-to-deploy (optional)

By default a deploy only happens when you call `deploy()`. You can opt a
project into **auto-deploy on push**: `set_auto_deploy('<name>', branch='main')`
makes every push to that branch rebuild + roll a new revision automatically
(same pipeline as `deploy()`), so `push = live`. `disable_auto_deploy('<name>')`
turns it back off; `status('<name>')` shows the current `auto_deploy_branch`.
Manual `deploy()` always works as an override.

Requires the `coders-kr` GitHub App (already installed if you've deployed a
private repo) to be subscribed to **Push events** — a one-time operator
toggle on the App. If pushes don't trigger a deploy, that subscription is
the thing to check.

---

## TL;DR

- Trust `X-Coders-User`; never build login; link to `mcp.coders.kr/sso/*`.
- `GET` = anonymous-OK, `POST` = auto-requires login.
- Cost per request ≈ `100 + duration_ms + (KB_out × 10)`, with the variable
  part divided by concurrency; static assets are free via the CDN.
- Anonymous pool empty → **all anonymous traffic 302s to sign-in** for the
  month. Per-user-per-site pool is small (300k).
- **A WebSocket is billed by egress bytes (idle ≈ free); a held long-poll/SSE
  request is billed by time (~60k micros/min) AND cut by Cloudflare at ~50s.**
  Prefer WebSockets for persistent channels; keep long-poll/SSE short. Set
  `timeout` and reconnect on drop (§5).
- **Managed LLM** (`type: llm`): no key of your own; forward `X-Coders-User` on
  every Claude call or it bills the anonymous pool. Tokens are the priciest
  axis — a $3 pool ≈ 140 Sonnet turns.
- Build at image time so cold starts stay fast.
- **`coders.yaml` is strict** — only the documented fields (§9) are
  allowed; an unknown key fails the deploy. Don't invent fields.
- **Hit friction deploying? File it** at the public tracker:
  `gh issue create --repo cykim8811/coders-feedback ...` (any error you worked
  around, confusing message, doc that didn't match reality — whether it's your
  mistake, the platform's, or this template's; the maintainers triage, don't
  self-censor). No `gh`? Use the `report_issue` MCP tool as a fallback.
