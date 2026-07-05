"""StealthMole hackathon API — real external observation kernels.

Ported from the sibling D4D project's proven client (same auth/rate-limit/
error handling), adapted here to feed STEALTHGRAPH's probabilistic fusion
engine instead of D4D's provenance/derivation graph. Each search result is
mapped to `Observation`s (engine/fusion.py) between the queried identifier
and every other identifier StealthMole surfaces alongside it — the same
same_entity evidence shape the demo dataset uses, just sourced live.

One `fire` = one logical query. Responses are memoized per (module, query)
by the caller (routes/live.py), and this module throttles its own outbound
rate regardless, because the hackathon key's budget is small and 429s are
frequent under bursty use.

Per the hackathon manual:
- DT (Darkweb Tracker) and UB (ULP Binder) are NOT provided → excluded.
- Sync modules (cds/cl/cb) + monitoring modules (rm/gm/lm) answer at request
  time via `GET /{m}/search?query=<category>:<value>`.
- Async modules (tt) use `/{m}/search/{indicator}/target/all` and may
  return partial data, requiring bounded polling of `/{m}/search/{id}`.
- Quota exhaustion is HTTP 426 (not 429). Auth is JWT/HS256, a fresh token
  per request (reusing a JWT yields 401). `GET /user/quotas` never
  consumes quota — safe to poll for a status display.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass, field

import httpx
import jwt

from app.core.config import settings
from app.engine.fusion import Observation

HOST = settings.stealthmole_host


@dataclass
class Module:
    id: str  # url path segment, e.g. "cds"
    code: str  # quota code, e.g. "CDS"
    label: str
    kind: str  # what it surfaces (for the derived fact's label)
    mode: str  # "simple" (sync/monitoring GET search) | "async"
    accepts: tuple[str, ...]  # query types it makes sense for


# Modules reachable in the hackathon, by query mode. `accepts` reflects each
# module's Supported Query Categories in the manual.
MODULES: dict[str, Module] = {
    m.id: m
    for m in [
        Module("cds", "CDS", "Compromised Dataset", "유출 크리덴셜(스틸러 로그)", "simple", ("email", "domain", "ip", "url")),
        Module("cl", "CL", "Credential Lookout", "노출 크리덴셜", "simple", ("email", "domain")),
        Module("cb", "CB", "Combo Binder", "콤보리스트", "simple", ("email", "domain")),
        Module("rm", "RM", "Ransomware Monitoring", "랜섬웨어 노출", "simple", ("domain",)),
        Module("gm", "GM", "Government Monitoring", "정부기관 노출", "simple", ("domain", "url")),
        Module("lm", "LM", "Leak Monitoring", "기업 유출 노출", "simple", ("domain", "url")),
        # tt accepts the telegram-native anchor types too (tox/hash/telegram
        # UID/handle/xmpp) — these are how a covert operator's accounts link
        # even after handle/UID rotation, which credential seeds never reach.
        Module("tt", "TT", "Telegram Tracker", "텔레그램 언급", "async",
               ("email", "domain", "url", "ip", "tox", "hash", "telegram",
                "handle", "xmpp", "invite")),
    ]
}

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_IPV4 = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
_URL = re.compile(r"^https?://", re.I)
_DOMAIN = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$", re.I)
# telegram-native anchors
_TOX = re.compile(r"^[0-9A-Fa-f]{76}$")          # TOX ID — 76 hex, a contact key
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")        # file / profile hash
_TG_UID = re.compile(r"^\d{5,15}$")               # immutable telegram numeric id
_HANDLE = re.compile(r"^@?[A-Za-z][A-Za-z0-9_]{4,31}$")  # @name / bare handle

# Seed prefixes accepted in `parse_seed` (explicit `type:value`).
_SEED_PREFIXES = (
    "email", "domain", "ip", "url", "tox", "hash", "telegram", "handle",
    "xmpp", "invite",
)


def classify(value: str) -> str | None:
    v = value.strip()
    low = v.lower()
    if low.startswith("xmpp:"):
        jid = v[5:].strip()
        return "xmpp" if "@" in jid else None
    # telegram deep links (invite / channel) — a shared contact channel
    if low.startswith(("t.me/", "https://t.me/", "http://t.me/")):
        return "invite"  # telegram deep link — a shared contact channel
    if _URL.match(v):
        return "url"
    if v.startswith("@") and _HANDLE.match(v):
        return "handle"
    if "/" in v or "\\" in v:
        return None
    if _TOX.match(v):
        return "tox"
    if _SHA256.match(v):
        return "hash"
    if _EMAIL.match(v) and ":" not in v:
        return "email"
    if _IPV4.match(v):
        return "ip"
    if _TG_UID.match(v):
        return "telegram"
    if ":" not in v and _DOMAIN.match(v):
        return "domain"
    if _HANDLE.match(v):  # bare handle token (letter-led, no dot, not numeric)
        return "handle"
    return None


def parse_seed(raw: str) -> tuple[str, str] | None:
    raw = raw.strip()
    if ":" in raw and raw.split(":", 1)[0] in _SEED_PREFIXES:
        t, v = raw.split(":", 1)
        return t, v.strip()
    t = classify(raw)
    return (t, raw) if t else None


def _jwt_token() -> str:
    payload = {
        "access_key": settings.stealthmole_access_key,
        "nonce": str(uuid.uuid4()),  # fresh per request (reuse → 401)
        "iat": int(time.time()),
    }
    return jwt.encode(payload, settings.stealthmole_secret_key)  # HS256 default


def configured() -> bool:
    return bool(settings.stealthmole_access_key and settings.stealthmole_secret_key)


class RateLimited(Exception):
    pass


class QuotaExceeded(Exception):
    pass


class StealthMoleError(Exception):
    pass


_last_call = {"t": 0.0}
_MIN_INTERVAL = 0.8  # be polite; the hackathon budget is tight


async def _get(path: str, params: dict | None = None) -> dict:
    if not configured():
        raise StealthMoleError("StealthMole 키가 설정되지 않았습니다")
    wait = _MIN_INTERVAL - (time.time() - _last_call["t"])
    if wait > 0:
        await asyncio.sleep(wait)
    headers = {"Authorization": f"Bearer {_jwt_token()}"}
    async with httpx.AsyncClient(base_url=HOST, timeout=30) as client:
        r = await client.get(path, params=params, headers=headers)
    _last_call["t"] = time.time()
    if r.status_code == 426:
        raise QuotaExceeded("StealthMole 쿼터 초과(426) — 이 모듈의 월간 한도 소진")
    if r.status_code == 429:
        raise RateLimited("StealthMole 레이트 리밋(429) — 잠시 후 다시 시도")
    if r.status_code >= 400:
        detail = r.text[:200]
        try:
            detail = r.json().get("detail", detail)
        except Exception:
            pass
        raise StealthMoleError(f"StealthMole {r.status_code}: {detail}")
    return r.json()


# ---------------------------------------------------------------- endpoints

_quota_cache: dict = {"t": 0.0, "data": None}


async def quotas() -> dict:
    """GET /user/quotas — never consumes quota; cached 20s to be extra polite."""
    if _quota_cache["data"] is not None and time.time() - _quota_cache["t"] < 20:
        return _quota_cache["data"]
    data = await _get("/user/quotas")
    _quota_cache["t"] = time.time()
    _quota_cache["data"] = data
    return data


def invalidate_quota_cache() -> None:
    _quota_cache["data"] = None


@dataclass
class SearchResult:
    module_id: str
    query: str
    total: int
    cost: int
    records: list[dict]
    identifiers: list[dict] = field(default_factory=list)  # {type, value, field, at}


# local-account / label fields — a value here only counts as a pivot if it is
# a real email; otherwise it is a name/id, not a queryable identifier.
_LOCAL_FIELDS = {
    "user", "username", "name", "computername", "password", "pass", "id",
    "regdate", "leakeddate", "date", "hash", "author", "victim", "title",
    "attack_group", "sector", "stealertype", "stealerpath", "highlight",
}

# Max distinct identifiers surfaced from one fire (see _extract_identifiers).
MAX_IDENTIFIERS_PER_FIRE = 30


def _extract_identifiers(records: list[dict], at: int | None = None) -> list[dict]:
    """Pull queryable identifiers (email/domain/ip/url) out of raw records.

    `at` is an optional unix timestamp (from the record itself, e.g.
    leakeddate/createDate) carried through so the caller can time-bound the
    resulting Observation.
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        rec_at = at
        for date_key in ("leakeddate", "createDate"):
            v = rec.get(date_key)
            if isinstance(v, int) and v > 0:
                rec_at = v
                break
        rec_ref = rec.get("_ref")  # node sha256, for later drill-down
        for k, v in rec.items():
            if k.startswith("_"):  # internal fields (e.g. _ref) aren't identifiers
                continue
            if not isinstance(v, str) or not v.strip():
                continue
            t = classify(v.strip())
            if t is None:
                continue
            if k.lower() in _LOCAL_FIELDS and t != "email":
                continue
            val = v.strip()
            key = (t, val.lower())
            if key in seen:
                continue
            seen.add(key)
            out.append({"type": t, "value": val, "field": k, "at": rec_at,
                        "ref": rec_ref if isinstance(rec_ref, str) else None})
    # anchors first (rare, low-forgeability) → then softer identifiers
    order = {"tox": 0, "telegram": 1, "hash": 2, "handle": 3, "xmpp": 4,
             "email": 5, "domain": 6, "ip": 7, "url": 8}
    out.sort(key=lambda i: order.get(i["type"], 9))
    # A single stealer-log machine dump (an ip pivot) legitimately carries
    # dozens of distinct accounts; surface a generous slice so the whole
    # machine "lights up" in one fire rather than a token 8.
    return out[:MAX_IDENTIFIERS_PER_FIRE]


def _flatten_async_item(item: dict) -> dict:
    """AsyncSearchItem → a flat dict of string fields for identifier scanning
    (value + parsed metadata JSON + createDate for time-bounding)."""
    out: dict = {}
    if not isinstance(item, dict):
        return out
    if isinstance(item.get("value"), str):
        out["value"] = item["value"]
        # a telegram.message result's value is "<channelId>_<msgIdx>"; surface
        # the channel id itself so a keyword/invite hit pivots to the channel.
        m = re.match(r"^(\d{5,15})_\d+$", item["value"])
        if m:
            out["channel_id"] = m.group(1)
    # keep the node's content-address (sha256) so we can later drill it
    # (/tt/node) for message text — used by the stylometry comparison.
    if isinstance(item.get("id"), str):
        out["_ref"] = item["id"]
    cd = item.get("createDate")
    if isinstance(cd, int):
        out["createDate"] = cd
    md = item.get("metadata")
    if isinstance(md, str) and md.strip():
        try:
            j = json.loads(md)
            if isinstance(j, dict):
                for k, val in j.items():
                    if isinstance(val, str):
                        out[f"meta_{k}"] = val
        except Exception:
            pass
    return out


async def _search_simple(mod: Module, qtype: str, value: str, limit: int) -> SearchResult:
    query = f"{qtype}:{value}"
    data = await _get(f"/{mod.id}/search", {"query": query, "limit": limit})
    records = data.get("data", []) if isinstance(data, dict) else []
    records = [r for r in records[:limit] if isinstance(r, dict)]
    return SearchResult(
        module_id=mod.id,
        query=query,
        total=int(data.get("totalCount", len(records))) if isinstance(data, dict) else len(records),
        cost=int(data.get("queryCost", 0)) if isinstance(data, dict) else 0,
        records=records,
        identifiers=_extract_identifiers(records),
    )


# node-type → tt search indicator. Most types map 1:1 to a tt indicator;
# handle/xmpp have no dedicated indicator so they go through free-text keyword.
_TT_INDICATOR = {"handle": "keyword", "xmpp": "keyword", "invite": "keyword"}


async def _search_async(mod: Module, qtype: str, value: str, limit: int) -> SearchResult:
    """Async modules: target/all + bounded polling of any pending targets."""
    query = f"{qtype}:{value}"
    indicator = _TT_INDICATOR.get(qtype, qtype)
    text = value
    if qtype == "invite":  # match by the invite token, not the whole URL
        text = value.rsplit("/", 1)[-1].lstrip("+")
    data = await _get(
        f"/{mod.id}/search/{indicator}/target/all",
        {"text": text, "limit": limit, "wait": "true"},
    )
    records: list[dict] = []
    total = 0
    pending: list[str] = []
    if isinstance(data, dict):
        for _target, resp in data.items():
            if not isinstance(resp, dict):
                continue
            total += int(resp.get("totalCount") or 0)
            for item in resp.get("data") or []:
                records.append(_flatten_async_item(item))
            if not resp.get("last", True):
                cid = resp.get("cid") or resp.get("id")
                if cid:
                    pending.append(cid)
    # bounded polling — at most 2 pending targets, one page each
    for cid in pending[:2]:
        try:
            pr = await _get(f"/{mod.id}/search/{cid}", {"limit": limit})
        except Exception:
            continue
        if isinstance(pr, dict):
            total = max(total, int(pr.get("totalCount") or 0))
            for item in pr.get("data") or []:
                records.append(_flatten_async_item(item))
    records = records[:limit]
    return SearchResult(
        module_id=mod.id, query=query, total=total, cost=0,
        records=records, identifiers=_extract_identifiers(records),
    )


async def search(module_id: str, qtype: str, value: str, limit: int = 5) -> SearchResult:
    """One query against one module for one identifier (dispatch by mode)."""
    mod = MODULES[module_id]
    if mod.mode == "async":
        return await _search_async(mod, qtype, value, limit)
    return await _search_simple(mod, qtype, value, limit)


# ------------------------------------------------------ evidence mapping
#
# Turns a SearchResult into `same_entity` Observations between the queried
# identifier and each co-occurring identifier StealthMole surfaced. The
# module chosen mirrors why that co-occurrence is credible:
#
#   cds — a single record is one stealer-log dump: host/user/password/ip/
#         username/computername all came off ONE compromised machine at ONE
#         moment. That is exactly the `device_fingerprint` module's
#         definition, so co-occurring identifiers get that module, anchored
#         to `leakeddate` when present.
#   tt  — a Telegram mention; if the surfaced value reads as a large numeric
#         id it's treated as the immutable `telegram_uid` anchor, otherwise
#         a softer `co_mention` (channel context, easy to stage).
#   cl/cb/rm/gm/lm — credential-reuse lists and monitoring feeds place
#         identifiers together by *listing*, not by device evidence, so
#         they map to the weaker, more forgeable `co_mention` module.

_MODULE_TO_EVIDENCE: dict[str, tuple[str, float]] = {
    "cl": ("co_mention", 0.68),
    "cb": ("co_mention", 0.62),
    "rm": ("co_mention", 0.55),
    "gm": ("co_mention", 0.55),
    "lm": ("co_mention", 0.55),
}

_NUMERIC_ID = re.compile(r"^\d{5,15}$")


def _evidence_for(
    module_id: str, seed_type: str, other_type: str, value: str
) -> tuple[str, float]:
    """Which evidence module + base raw a co-occurrence maps to.

    The key refinement: within CDS a co-occurring *identity* (another email,
    or the machine's ip) is device-fingerprint co-residency — a strong
    same-entity signal; a co-occurring *service* (url/domain the identity
    logged into) is only a soft `co_mention`, since "this identity uses
    netflix.com" says little about identity. Type-blind mapping (everything
    → device_fingerprint) over-connected services into the identity cluster.

    For tt, the *seed anchor* decides the evidence: co-occurring accounts
    that all advertise one TOX contact key are the same operation
    (`tox_reuse`); ones sharing an XMPP/invite are a softer shared contact;
    ones sharing a leaked file hash are only redistribution (`file_reuse`).
    """
    if module_id == "tt":
        if seed_type == "tox" or other_type == "tox":
            return ("tox_reuse", 0.90)          # shared private contact key
        if seed_type in ("xmpp", "invite") or other_type in ("xmpp", "invite"):
            return ("shared_contact", 0.66)
        if seed_type == "hash" or other_type == "hash":
            return ("file_reuse", 0.42)         # same file redistributed
        if other_type == "telegram" or _NUMERIC_ID.match(value):
            return ("telegram_uid", 0.85)       # immutable numeric id anchor
        return ("co_mention", 0.60)
    if module_id == "cds":
        if other_type in ("email", "ip"):
            return ("device_fingerprint", 0.90)  # same-machine co-residency
        return ("co_mention", 0.55)  # a service the identity touched
    return _MODULE_TO_EVIDENCE.get(module_id, ("co_mention", 0.55))


def to_observations(
    module_id: str, seed_type: str, seed_value: str, res: SearchResult
) -> list[tuple[str, str, Observation, str | None]]:
    """(other_type, other_value, Observation, ref) for every identifier this
    result surfaced alongside the seed. `ref` is the node's sha256 (for later
    drill-down) or None. `seed_value` is excluded from its own identifier list
    (StealthMole often echoes it back)."""
    out: list[tuple[str, str, Observation, str | None]] = []
    for ident in res.identifiers:
        val = ident["value"]
        if val.lower() == seed_value.lower():
            continue
        at = ident.get("at")
        source = f"stealthmole:{module_id}"
        ev_module, raw = _evidence_for(module_id, seed_type, ident["type"], val)
        note = f"StealthMole {MODULES[module_id].code} · {ident['field']} 필드에서 공출현"
        obs = Observation(module=ev_module, raw=raw, source=source, frm=at, note=note)
        out.append((ident["type"], val, obs, ident.get("ref")))
    return out


# ---------------------------------------------------- stylometry / negative
#
# The anchor modules (tox_reuse, telegram_uid) can only ARGUE-FOR a link.
# Real attribution needs a channel that can ARGUE-AGAINST it: two accounts
# that share a forgeable bridge (a name, a co-mention) but write in a
# different language and sell a different product are NOT the same operation.
# `node_style` drills an account's messages; `style_observations` compares two
# profiles and emits a `stylometry` Observation whose raw is < 0.5 (a negative
# LLR that PULLS THE EDGE DOWN) when they diverge — the automated GANOSEC
# refutation. Heuristic today (content-class + script mix); the same interface
# accepts an LLM verdict later.

# content-class fingerprints — distinctive phrasing per operation type
_STYLE_MARKERS: dict[str, tuple[str, ...]] = {
    "data_broker": ("file information", "total records", "vip members", "tox id support",
                    "compromised data", "breach date", "database brought this", "uncompressed"),
    "ransomware": ("pay the ransom", "decrypt", "add time", "delete all data",
                   "buy and download", "ransomhub", "blackcat", "lockbit"),
    "hacktivist": ("defaced", "#opisrael", "indohaxsec", "allahuakbar", "free palestine",
                   "hacked by", "ganosec", "redeye", "opisrael", "#indohaxsec"),
    "carding": ("cvv", "fullz", "dumps+pin", "combolist", "bank logs"),
}


def _script_mix(text: str) -> dict[str, float]:
    counts = {"latin": 0, "arabic": 0, "cyrillic": 0, "cjk": 0, "hangul": 0}
    total = 0
    for ch in text:
        o = ord(ch)
        if not ch.isalpha():
            continue
        total += 1
        if o < 0x250:
            counts["latin"] += 1
        elif 0x600 <= o <= 0x6FF:
            counts["arabic"] += 1
        elif 0x400 <= o <= 0x4FF:
            counts["cyrillic"] += 1
        elif 0xAC00 <= o <= 0xD7A3:
            counts["hangul"] += 1
        elif 0x3040 <= o <= 0x9FFF:
            counts["cjk"] += 1
    if total == 0:
        return {k: 0.0 for k in counts}
    return {k: round(v / total, 3) for k, v in counts.items()}


def _style_profile(text: str, title: str = "") -> dict:
    low = (title + "\n" + text).lower()
    classes = {c: sum(low.count(m) for m in ms) for c, ms in _STYLE_MARKERS.items()}
    top = max(classes, key=classes.get) if any(classes.values()) else None
    return {
        "top_class": top,
        "classes": classes,
        "scripts": _script_mix(text),
        "chars": len(text),
    }


async def node_style(ref: str) -> dict:
    """Drill a tt node (channel/user) by sha256 and profile its writing —
    content class + script mix. Empty profile if no text (e.g. a bare user)."""
    data = await _get("/tt/node", {"id": ref})
    if not isinstance(data, dict):
        return _style_profile("")
    parts: list[str] = []
    for key in ("message", "messagehisto"):
        v = data.get(key)
        if isinstance(v, list):
            parts.extend(m for m in v if isinstance(m, str))
    return _style_profile("\n".join(parts), str(data.get("title", "")))


def _script_overlap(a: dict, b: dict) -> float:
    keys = set(a) | set(b)
    dot = sum(a.get(k, 0) * b.get(k, 0) for k in keys)
    na = sum(v * v for v in a.values()) ** 0.5
    nb = sum(v * v for v in b.values()) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def style_observations(prof_a: dict, prof_b: dict) -> list[Observation]:
    """Compare two style profiles → a `stylometry` Observation. raw > 0.5 if
    they read as the same operator, raw < 0.5 (negative — refutes) if they
    diverge. Returns [] when there isn't enough text to judge."""
    if prof_a["chars"] < 120 or prof_b["chars"] < 120:
        return []  # not enough signal to argue either way
    ca, cb = prof_a["top_class"], prof_b["top_class"]
    script = _script_overlap(prof_a["scripts"], prof_b["scripts"])
    if ca and cb and ca != cb:
        raw = 0.14  # different product/motive → strong "different operation"
        note = f"운영 성격 상이: {ca} ↔ {cb} · 문자체계 유사도 {script:.0%} → 다른 주체"
    elif ca and cb and ca == cb:
        raw = min(0.85, 0.60 + 0.25 * script)
        note = f"동일 운영 성격({ca}) + 문자체계 유사도 {script:.0%} → 동일 주체 지지"
    else:
        raw = 0.35 + 0.15 * script  # one side unclassified: weak, script-led
        note = f"내용 분류 불명확 · 문자체계 유사도 {script:.0%}"
    return [Observation(module="stylometry", raw=round(raw, 2),
                        source="derived:stylometry", note=note)]


def local_part(identifier: str) -> str:
    """The part of an email/handle that carries the persona name."""
    return identifier.split("@", 1)[0].lower()


def handle_similarity(a: str, b: str) -> float:
    """Normalised longest-common-substring similarity of two identifiers'
    local parts (0..1). Catches an operator's formulaic persona family —
    `billyvienneau420` ~ `billyvienneau6969`, or `ern.wet91` ~ `liz.wet91`."""
    a, b = local_part(a), local_part(b)
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return 0.0
    prev = [0] * (lb + 1)
    best = 0
    for i in range(la):
        cur = [0] * (lb + 1)
        for j in range(lb):
            if a[i] == b[j]:
                cur[j + 1] = prev[j] + 1
                if cur[j + 1] > best:
                    best = cur[j + 1]
        prev = cur
    return best / max(la, lb)
