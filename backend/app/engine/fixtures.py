"""Canned StealthMole responses for the flagship *offline* demo mission.

The live hackathon key's data connection is not always up (quota drain, key
rotation, event window closed). A public demo cannot depend on it. This module
supplies pre-recorded, fully FABRICATED search results for one hand-authored
"dirty" entity-resolution case so the mission runs with **zero** StealthMole
connectivity — yet still flows through the *real* fusion engine: rarity-breadth
discounting, multi-device bridging, and stylometry refutation all genuinely
compute on this frozen input.

Design contract (so there is no import cycle with `stealthmole.py`):
  * This file imports NOTHING from `stealthmole`. It exports plain data.
  * `stealthmole.search()` short-circuits on a `SEARCH` hit and wraps it in a
    real `SearchResult`; `stealthmole.node_style()` short-circuits on `STYLE`.
  * Keys are `(module_id, qtype, value.lower())`. These identifiers are
    invented — they will never collide with a real StealthMole query, so the
    fixtures are inert for any genuine investigation.

Every name/domain/wallet/handle here is fictional. `hanul-defense.io` is a
made-up contractor used only to mirror the *methodology* of a defense-sector
initial-access-broker case — no real victim PII is represented.
"""

from __future__ import annotations

# ---- the cast (all fabricated) -------------------------------------------
TOX = "992BBBCBDBE33F42E4E5951ACA0A211114BEE0A47708B39341A8B1F523AAEAB2DBC4579AE2B3"
HASH = "ad9cec032c8343f09b89c254e7ae73dca39f170ae2afee3990ff21373ee5f106"
OP_CHANNEL = "7742119003"      # operator's real broker channel (drillable)
BURNER_A = "7742119888"        # disposable support account
BURNER_B = "7742120044"        # disposable support account
COPYCAT_HANDLE = "KRAKEN_TEAM"  # impersonator (drillable, co_mention) — refuted
PERSONA_EMAIL = "kraken.access@onionmail.org"
DEVICE1_IP = "45.130.88.207"   # operator's infected workstation
DEVICE2_IP = "188.72.14.33"    # operator's personal laptop (bridge target)
DECOY_CRED = "svc-vpn@hanul-defense.io"        # widely-traded service cred (trap)
RARE_ANCHOR = "d.kovalenko88@protonmail.com"   # rare personal cred (true anchor)
REAL_NAME_MAIL = "dmytro.kovalenko@gmail.com"  # real-name reveal
VICTIM_DOMAIN = "hanul-defense.io"


def _id(t: str, v: str, field: str, ref: str | None = None) -> dict:
    return {"type": t, "value": v, "field": field, "at": None, "ref": ref}


# ---- SEARCH fixtures: (module_id, qtype, value.lower()) -> canned result ---
# Each value is {total, cost, identifiers:[{type,value,field,at,ref}], records}
SEARCH: dict[tuple[str, str, str], dict] = {
    # STEP 2 — TT on the burner handle. The operation lights up: the immutable
    # TOX contact key (strong anchor) binds the operator's real channel and two
    # disposable support burners; the persona email, a leaked "proof pack" file
    # hash, and the victim domain come along as softer context.
    ("tt", "handle", "apt_broker"): {
        "total": 47, "cost": 0, "records": [],
        "identifiers": [
            _id("tox", TOX, "tox_id"),
            _id("telegram", OP_CHANNEL, "channel", ref="op_main"),
            _id("telegram", BURNER_A, "support"),
            _id("telegram", BURNER_B, "support"),
            _id("email", PERSONA_EMAIL, "contact"),
            _id("hash", HASH, "proof_pack"),
            _id("domain", VICTIM_DOMAIN, "target"),
        ],
    },
    # STEP 3 — CDS on the persona email. One stealer-log machine: the infected
    # workstation ip, plus everything saved in that browser — INCLUDING a shared
    # VPN service credential (the decoy) and a rare personal cred (the anchor).
    ("cds", "email", PERSONA_EMAIL.lower()): {
        "total": 63, "cost": 50, "records": [],
        "identifiers": [
            _id("ip", DEVICE1_IP, "ip"),
            _id("email", DECOY_CRED, "user"),
            _id("email", RARE_ANCHOR, "user"),
            _id("domain", "citrix.hanul-defense.io", "host"),
            _id("url", "https://vpn.hanul-defense.io/logon", "host"),
        ],
    },
    # STEP 4 — CB on the decoy. total=9,300: this credential is combo-list
    # inventory, held by countless unrelated machines. Reuse-breadth rarity
    # collapses its device edge toward neutral — it is NOT a co-conspirator link.
    ("cb", "email", DECOY_CRED.lower()): {
        "total": 9300, "cost": 50, "records": [], "identifiers": [],
    },
    # STEP 5 — CB on the rare anchor. total=1: essentially unique, absent from
    # combo lists. Its device edge is NOT discounted — this genuinely points at
    # one person.
    ("cb", "email", RARE_ANCHOR.lower()): {
        "total": 1, "cost": 50, "records": [], "identifiers": [],
    },
    # STEP 6 — CDS on the rare anchor. It bridges to a SECOND infected device
    # (the personal laptop), which carries a real-name gmail — the reveal.
    ("cds", "email", RARE_ANCHOR.lower()): {
        "total": 11, "cost": 50, "records": [],
        "identifiers": [
            _id("ip", DEVICE2_IP, "ip"),
            _id("email", REAL_NAME_MAIL, "user"),
            _id("domain", "linkedin.com", "host"),
        ],
    },
    # STEP 8 — TT back on the operator's OWN channel, to sweep for accounts
    # citing/impersonating it. A handle "KRAKEN_TEAM" surfaces — it links only
    # by shared branding (co_mention, forgeable). Same crew, or a name-rider?
    # The stylometry step adjudicates it on the very same edge.
    ("tt", "telegram", OP_CHANNEL): {
        "total": 4, "cost": 0, "records": [],
        "identifiers": [
            _id("handle", COPYCAT_HANDLE, "mention", ref="copycat"),
        ],
    },
}


# ---- STYLE fixtures: node ref -> {title, text} for node_style() -----------
# Drilled during the stylometry comparison. The operator's real channel writes
# like a commercial data broker; the KRAKEN-TEAM copycat writes like a web-
# defacement hacktivist crew. Different content class → strong "different
# operator" refutation (raw 0.14), overturning the shared-name link.
STYLE: dict[str, dict] = {
    "op_main": {
        "title": "APT_BROKER | ACCESS SALES",
        "text": (
            "FILE INFORMATION — hanul-defense contractor batch. Compromised "
            "data: Citrix and VPN access to the internal share, verified this "
            "week. Total records included with sample. Breach date is recent. "
            "VIP members get priority delivery. Tox ID support only for serious "
            "buyers, no time-wasters. Uncompressed database brought fresh; price "
            "in XMR only, escrow available for large orders."
        ),
    },
    "copycat": {
        "title": "KRAKEN-TEAM OFFICIAL",
        "text": (
            "Hacked by KRAKEN-TEAM. We defaced their public portal today for the "
            "cause. #OpIsrael and free palestine, allahuakbar. Redeye and ganosec "
            "brothers, we ride together against the occupiers. This is only the "
            "beginning — stay tuned for the next target, the whole system will "
            "fall. Share and spread the message, no gods no masters."
        ),
    },
}


def has_search(module_id: str, qtype: str, value: str) -> dict | None:
    return SEARCH.get((module_id, qtype, value.lower()))
