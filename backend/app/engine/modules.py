"""Evidence modules.

Each module emits, for a pair of identifiers, a *support signal* in
[0, 1] where 0.5 is neutral, > 0.5 argues "same entity", < 0.5 argues
"different entity". A module carries two intrinsic properties that shape
how much its signal counts in fusion:

    weight       — base trust in the module (0..1)
    forgeability — how cheaply an adversary can fake this signal
                   (0 = impossible, 1 = trivial). Higher forgeability
                   discounts the effective weight (see fusion.py).

The registry below is the single source of truth; the API echoes it to
the client so evidence modules can be toggled / re-weighted live.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Module:
    key: str
    label: str
    weight: float
    forgeability: float
    description: str


# Order matters only for display (strongest → weakest).
MODULES: dict[str, Module] = {
    m.key: m
    for m in [
        Module(
            "device_fingerprint",
            "기기 지문",
            1.00,
            0.05,
            "computername + OS user + IP 일치. 스틸러 로그가 기기를 통째로 "
            "덤프하므로 위조가 사실상 불가능하다.",
        ),
        Module(
            "telegram_uid",
            "텔레그램 UID",
            1.00,
            0.05,
            "불변 숫자 ID 일치. 핸들(@name)이 바뀌어도 계정의 숫자 UID는 "
            "유지되므로 정체성의 앵커가 된다.",
        ),
        Module(
            "pgp_reuse",
            "PGP 키 재사용",
            0.95,
            0.08,
            "동일 PGP 지문으로 서명. 개인키 없이는 위조할 수 없다.",
        ),
        Module(
            "wallet_cospend",
            "지갑 공동서명",
            0.92,
            0.12,
            "같은 트랜잭션에 공동입력(co-spend). 두 지갑의 키를 한 주체가 "
            "동시에 통제했다는 강한 증거.",
        ),
        Module(
            "tox_reuse",
            "TOX 연락처 공유",
            0.90,
            0.12,
            "동일 TOX/보안메신저 연락키를 광고. 개인 연락키를 공유한다는 것은 "
            "동일 운영 주체라는 강한 신호다 — 핸들·UID가 바뀌어도 유지된다.",
        ),
        Module(
            "co_mention",
            "공동 언급",
            0.60,
            0.45,
            "같은 문서·메시지·채널에 함께 등장. 정황 증거이며 위조가 어렵지 "
            "않다.",
        ),
        Module(
            "shared_contact",
            "공유 연락 채널",
            0.62,
            0.45,
            "동일 비공개 초대링크·XMPP 등 연락 채널을 공유. 재게시로 복제될 "
            "수 있어 정황 수준의 신호.",
        ),
        Module(
            "file_reuse",
            "동일 유출파일 재유포",
            0.42,
            0.55,
            "같은 유출 파일(해시)을 유포. 재판매·미러로 여러 주체가 같은 파일을 "
            "돌릴 수 있어 약한 신호(유포망 ≠ 통제).",
        ),
        Module(
            "stylometry",
            "문체 유사",
            0.55,
            0.70,
            "글쓰기 습관·거래 문구의 유사도(LLM 추론). 의도적 흉내로 위조 "
            "가능.",
        ),
        Module(
            "timezone",
            "활동 시간대",
            0.45,
            0.80,
            "활동 시각 분포의 일치. VPN·스케줄러로 쉽게 교란된다.",
        ),
        Module(
            "shared_infra_ip",
            "공유 인프라 IP",
            0.42,
            0.65,
            "동일 출구 IP. 공유 VPN·NAT 뒤에서는 서로 다른 주체도 같은 IP를 "
            "쓰므로 false-flag 위험이 있다.",
        ),
        Module(
            "handle_similarity",
            "핸들 유사",
            0.40,
            0.85,
            "별칭 문자열의 유사도. 누구나 흉내낼 수 있어 가장 약한 신호.",
        ),
    ]
}


MODULE_ORDER: list[str] = list(MODULES.keys())
