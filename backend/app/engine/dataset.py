"""The demo corpus.

~35 identifier nodes and their timestamped pairwise observations,
hand-authored so the four canonical behaviours are all reachable from
the default seed:

  1. OVER-MERGE — KESTREL and VIPER are two different actors joined only
     by a weak, forgeable bridge (shared VPN exit IP + one co-mention).
     Lower θ below the bridge probability and the two collapse into one.

  2. ABLATION — the `night_raven` forum persona hangs off KESTREL almost
     entirely on soft evidence (stylometry + timezone + co-mention). Turn
     those modules off and the link falls below θ.

  3. TIME SEPARATION — `crow_walker` was an alias of KESTREL that was
     SOLD to another actor at T_TRANSFER, who kept posting as
     `sable_kite`. Before the sale: co-spend + shared style → P≈0.95.
     After: a stylometry break + timezone shift (raw<0.5) → P≈0.06,
     flagged `contested`.

  4. IMMUTABLE ANCHOR — KESTREL renamed `kestrel_ops` → `k3strel`; the
     handles barely resemble each other, but the shared Telegram UID and
     PGP key hold the identity together regardless.

Coordinates are not stored — the client lays the graph out with force
simulation. Time is unix seconds; see TIME below.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.engine.fusion import Observation

# --- Timeline anchors (fixed; no wall-clock so the demo is reproducible) ---
T_START = 1_672_531_200  # 2023-01-01
T_TRANSFER = 1_717_200_000  # 2024-06-01  — the crow_walker account sale
T_END = 1_748_736_000  # 2025-06-01
T_DEFAULT = T_END  # timeline scrubber's initial position


@dataclass(frozen=True)
class Node:
    id: str
    type: str  # handle | email | wallet | telegram | device | pgp | ip | forum
    label: str
    anchor: bool = False  # immutable identifier (UID / device / PGP)
    sources: tuple[str, ...] = ()
    meta: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Edge:
    a: str
    b: str
    obs: tuple[Observation, ...]


def _n(*args, **kwargs) -> Node:
    return Node(*args, **kwargs)


NODES: list[Node] = [
    # ---- KESTREL cluster (actor A) ----
    _n("h_kes1", "handle", "kestrel_ops", sources=("exploit.in", "telegram"),
       meta={"role": "브로커", "first_seen": "2023-02"}),
    _n("h_kes2", "handle", "k3strel", sources=("telegram",),
       meta={"role": "브로커(개명)", "note": "kestrel_ops 리네임"}),
    _n("tg_kes", "telegram", "TG:774451201", anchor=True, sources=("telegram",),
       meta={"uid": "774451201", "immutable": "숫자 UID"}),
    _n("em_kes", "email", "kestrel@proton.me", sources=("breach-dump", "pgp"),
       meta={}),
    _n("pgp_kes", "pgp", "PGP:9A3F…KESTREL", anchor=True, sources=("keyserver",),
       meta={"fpr": "9A3F 21C7 … B0E4"}),
    _n("wal_kes", "wallet", "bc1q…kes7", sources=("chain",),
       meta={"chain": "BTC"}),
    _n("dev_kes", "device", "WIN-KESTREL / kdev", anchor=True,
       sources=("stealer-log",), meta={"os": "Windows 10", "user": "kdev"}),
    _n("ip_kes", "ip", "185.220.101.44", sources=("netflow",),
       meta={"asn": "VPN exit", "note": "공유 출구 IP"}),
    _n("forum_kes", "forum", "kestrel@xss.is", sources=("xss.is",), meta={}),

    # ---- crow_walker → sable_kite (account transfer) ----
    _n("h_crow", "handle", "crow_walker", sources=("telegram", "chain"),
       meta={"note": "KESTREL 부계정 → 양도됨"}),
    _n("wal_crow", "wallet", "bc1q…crow", sources=("chain",),
       meta={"chain": "BTC"}),
    _n("h_sable", "handle", "sable_kite", sources=("telegram",),
       meta={"note": "양도 후 새 운영자"}),
    _n("tg_sable", "telegram", "TG:918330557", anchor=True, sources=("telegram",),
       meta={"uid": "918330557", "active_from": "2024-06"}),
    _n("h_broker", "handle", "escrow_bird", sources=("telegram",),
       meta={"role": "에스크로/중개"}),

    # ---- night_raven (soft-evidence persona; ablation demo) ----
    _n("forum_raven", "forum", "night_raven", sources=("xss.is",), meta={}),
    _n("h_raven", "handle", "nightraven", sources=("telegram",), meta={}),

    # ---- VIPER cluster (actor B — a DIFFERENT person) ----
    _n("h_vip1", "handle", "viper_market", sources=("telegram", "xss.is"),
       meta={"role": "마켓 운영"}),
    _n("h_vip2", "handle", "viper_x", sources=("telegram",), meta={}),
    _n("tg_vip", "telegram", "TG:551209884", anchor=True, sources=("telegram",),
       meta={"uid": "551209884"}),
    _n("em_vip", "email", "viper@tuta.io", sources=("pgp",), meta={}),
    _n("pgp_vip", "pgp", "PGP:71B0…VIPER", anchor=True, sources=("keyserver",),
       meta={"fpr": "71B0 5DE2 … 9CC1"}),
    _n("wal_vip", "wallet", "bc1q…vip3", sources=("chain",), meta={"chain": "BTC"}),
    _n("dev_vip", "device", "DESKTOP-VIPER / v", anchor=True,
       sources=("stealer-log",), meta={"os": "Windows 11"}),
    _n("ip_vip", "ip", "185.220.101.51", sources=("netflow",),
       meta={"asn": "VPN exit"}),

    # ---- peripheral noise (weak links, never cross θ) ----
    _n("h_noise1", "handle", "shadowfax", sources=("forum",), meta={}),
    _n("em_noise1", "email", "sfax@mail.ru", sources=("breach-dump",), meta={}),
    _n("wal_noise1", "wallet", "bc1q…nz1", sources=("chain",), meta={}),
    _n("ip_noise1", "ip", "45.83.220.9", sources=("netflow",), meta={}),
    _n("h_noise2", "handle", "zero_cool", sources=("forum",), meta={}),
    _n("em_noise2", "email", "zc@xmail.io", sources=("breach-dump",), meta={}),
    _n("tg_noise", "telegram", "TG:203118742", sources=("telegram",), meta={}),
    _n("dev_noise", "device", "LAPTOP-Q / guest", sources=("stealer-log",), meta={}),
    _n("pgp_noise", "pgp", "PGP:04CD…", sources=("keyserver",), meta={}),
    _n("wal_noise2", "wallet", "bc1q…nz2", sources=("chain",), meta={}),
]


def O(module, raw, source, frm=None, to=None, note=""):  # noqa: N802 (terse builder)
    return Observation(module=module, raw=raw, source=source, frm=frm, to=to, note=note)


EDGES: list[Edge] = [
    # ===== KESTREL internal — anchored, high confidence =====
    Edge("h_kes1", "tg_kes", (
        O("telegram_uid", 1.0, "telegram", note="kestrel_ops 계정의 숫자 UID"),
    )),
    # Immutable-anchor demo: renamed handle, held by the SAME Telegram UID
    # even though the two handle strings barely resemble each other.
    Edge("h_kes2", "tg_kes", (
        O("telegram_uid", 1.0, "telegram", frm=T_TRANSFER,
          note="개명 후에도 동일 UID 유지"),
    )),
    Edge("h_kes1", "h_kes2", (
        O("handle_similarity", 0.30, "heuristic",
          note="kestrel_ops ↔ k3strel: 문자열만으로는 약함"),
    )),
    Edge("pgp_kes", "em_kes", (
        O("pgp_reuse", 1.0, "keyserver", note="이메일이 이 PGP 키로 서명됨"),
    )),
    Edge("pgp_kes", "h_kes1", (
        O("pgp_reuse", 0.95, "xss.is", note="포럼 게시물 PGP 서명"),
    )),
    Edge("dev_kes", "h_kes1", (
        O("device_fingerprint", 0.95, "stealer-log",
          note="스틸러 로그: 기기 지문 ↔ 핸들 로그인"),
    )),
    Edge("dev_kes", "em_kes", (
        O("device_fingerprint", 0.90, "stealer-log"),
    )),
    Edge("wal_kes", "h_kes1", (
        O("co_mention", 0.75, "telegram", note="채널에 지갑 주소 게시"),
    )),
    Edge("wal_kes", "pgp_kes", (
        O("co_mention", 0.70, "xss.is"),
    )),
    Edge("ip_kes", "dev_kes", (
        O("shared_infra_ip", 0.80, "netflow"),
    )),
    Edge("forum_kes", "h_kes1", (
        O("stylometry", 0.85, "llm-stylometry", note="거래 문구 습관 일치"),
        O("co_mention", 0.70, "xss.is"),
    )),

    # ===== crow_walker: KESTREL alias, then SOLD =====
    Edge("wal_crow", "wal_kes", (
        O("wallet_cospend", 0.90, "chain", to=T_TRANSFER,
          note="양도 전 공동입력 트랜잭션"),
    )),
    Edge("h_crow", "wal_crow", (
        O("co_mention", 0.80, "telegram"),
    )),
    Edge("h_crow", "h_kes1", (
        O("stylometry", 0.80, "llm-stylometry", to=T_TRANSFER),
        O("co_mention", 0.70, "telegram", to=T_TRANSFER),
    )),
    # THE transfer edge — strong before T_TRANSFER, contested after.
    Edge("h_crow", "h_sable", (
        O("wallet_cospend", 0.90, "chain", to=T_TRANSFER,
          note="양도 전 공동서명"),
        O("stylometry", 0.85, "llm-stylometry", to=T_TRANSFER,
          note="양도 전 동일 문체"),
        O("handle_similarity", 0.80, "heuristic", to=T_TRANSFER,
          note="crow_walker ↔ sable_kite (조류 테마)"),
        O("stylometry", 0.15, "llm-stylometry", frm=T_TRANSFER,
          note="양도 후 문체 단절 — 다른 사람"),
        O("timezone", 0.10, "netflow", frm=T_TRANSFER,
          note="양도 후 활동 시간대 이동 (UTC+3 → UTC+8)"),
    )),
    Edge("h_sable", "tg_sable", (
        O("telegram_uid", 1.0, "telegram", frm=T_TRANSFER,
          note="양도 후 새 운영자의 고유 UID"),
    )),
    Edge("h_broker", "h_crow", (
        O("co_mention", 0.65, "telegram", note="에스크로가 매물 공지"),
    )),
    Edge("h_broker", "h_sable", (
        O("co_mention", 0.65, "telegram", frm=T_TRANSFER),
    )),

    # ===== night_raven: soft-evidence only (ablation demo) =====
    Edge("forum_raven", "h_kes1", (
        O("stylometry", 0.85, "llm-stylometry"),
        O("timezone", 0.80, "netflow"),
        O("co_mention", 0.75, "xss.is"),
    )),
    Edge("h_raven", "forum_raven", (
        O("handle_similarity", 0.70, "heuristic", note="nightraven ↔ night_raven"),
        O("co_mention", 0.60, "telegram"),
    )),

    # ===== VIPER internal — anchored, high confidence =====
    Edge("h_vip1", "tg_vip", (
        O("telegram_uid", 1.0, "telegram"),
    )),
    Edge("h_vip2", "tg_vip", (
        O("telegram_uid", 1.0, "telegram"),
    )),
    Edge("h_vip1", "h_vip2", (
        O("handle_similarity", 0.75, "heuristic", note="viper_market ↔ viper_x"),
    )),
    Edge("pgp_vip", "h_vip1", (
        O("pgp_reuse", 0.95, "xss.is"),
    )),
    Edge("pgp_vip", "em_vip", (
        O("pgp_reuse", 1.0, "keyserver"),
    )),
    Edge("dev_vip", "h_vip1", (
        O("device_fingerprint", 0.92, "stealer-log"),
    )),
    Edge("wal_vip", "h_vip1", (
        O("co_mention", 0.72, "telegram"),
    )),
    Edge("ip_vip", "dev_vip", (
        O("shared_infra_ip", 0.78, "netflow"),
    )),

    # ===== THE BRIDGE — KESTREL ↔ VIPER (false-merge trap) =====
    # Two different actors, joined only by weak forgeable signals: they
    # rent the same VPN exit and were co-mentioned once. P≈0.54, so a θ
    # below that fuses them — the over-merge the whole design guards against.
    Edge("h_kes1", "h_vip1", (
        O("shared_infra_ip", 0.75, "netflow", note="동일 VPN 출구 IP 대역"),
        O("co_mention", 0.70, "xss.is", note="같은 스레드에 함께 언급"),
    )),
    Edge("ip_kes", "ip_vip", (
        O("shared_infra_ip", 0.72, "netflow", note="인접 VPN 출구 IP"),
    )),

    # ===== peripheral noise — reachable but stays under θ =====
    Edge("h_noise1", "h_kes1", (O("co_mention", 0.55, "forum"),)),
    Edge("em_noise1", "h_noise1", (O("co_mention", 0.60, "breach-dump"),)),
    Edge("wal_noise1", "wal_kes", (O("shared_infra_ip", 0.60, "chain"),)),
    Edge("ip_noise1", "ip_kes", (O("shared_infra_ip", 0.65, "netflow"),)),
    Edge("h_noise2", "h_vip1", (O("co_mention", 0.55, "forum"),)),
    Edge("em_noise2", "h_noise2", (O("co_mention", 0.60, "breach-dump"),)),
    Edge("tg_noise", "h_noise2", (O("timezone", 0.70, "netflow"),)),
    Edge("dev_noise", "h_noise1", (O("timezone", 0.65, "netflow"),)),
    Edge("pgp_noise", "em_noise2", (O("handle_similarity", 0.50, "heuristic"),)),
    Edge("wal_noise2", "wal_vip", (O("shared_infra_ip", 0.55, "chain"),)),
]


# Seeds offered as investigation starting points.
SEEDS: list[dict[str, str]] = [
    {"id": "h_kes1", "label": "kestrel_ops", "hint": "KESTREL — 과병합/앵커/양도 데모"},
    {"id": "h_vip1", "label": "viper_market", "hint": "VIPER — 별개 행위자"},
    {"id": "h_crow", "label": "crow_walker", "hint": "양도된 계정 (시간 분리)"},
    {"id": "h_sable", "label": "sable_kite", "hint": "양도 후 새 운영자"},
]

DEFAULT_SEED = "h_kes1"

NODES_BY_ID: dict[str, Node] = {n.id: n for n in NODES}
