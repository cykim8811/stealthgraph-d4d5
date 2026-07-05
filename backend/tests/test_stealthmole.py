"""Pure-function tests for the StealthMole client's classification and
evidence-mapping logic — no network calls."""

from __future__ import annotations

from app.engine import stealthmole as sm


def test_classify():
    assert sm.classify("a@b.com") == "email"
    assert sm.classify("1.2.3.4") == "ip"
    assert sm.classify("example.com") == "domain"
    assert sm.classify("https://example.com/x") == "url"
    assert sm.classify("not a value/with slash") is None


def test_parse_seed_bare_and_prefixed():
    assert sm.parse_seed("a@b.com") == ("email", "a@b.com")
    assert sm.parse_seed("domain:example.com") == ("domain", "example.com")
    assert sm.parse_seed("garbage!!!") is None


def test_cds_record_maps_to_device_fingerprint():
    """A CDS stealer-log record's co-occurring fields should map to the
    device_fingerprint evidence module, anchored to leakeddate."""
    records = [
        {
            "host": "example.com",
            "user": "victim@example.com",
            "password": "hunter2",
            "ip": "1.2.3.4",
            "username": "victim",
            "computername": "PC-01",
            "leakeddate": 1710000000,
        }
    ]
    identifiers = sm._extract_identifiers(records)
    result = sm.SearchResult(
        module_id="cds", query="email:victim@example.com", total=1, cost=50,
        records=records, identifiers=identifiers,
    )
    obs = sm.to_observations("cds", "victim@example.com", result)
    # the IP is the clearest non-seed identifier extracted
    ip_obs = [o for o in obs if o[0] == "ip" and o[1] == "1.2.3.4"]
    assert len(ip_obs) == 1
    _, _, observation = ip_obs[0]
    assert observation.module == "device_fingerprint"
    assert observation.frm == 1710000000


def test_tt_numeric_value_maps_to_telegram_uid():
    result = sm.SearchResult(
        module_id="tt", query="email:x@y.com", total=1, cost=0,
        records=[], identifiers=[{"type": "email", "value": "774451201", "field": "value", "at": None}],
    )
    obs = sm.to_observations("tt", "x@y.com", result)
    assert len(obs) == 1
    other_type, other_value, observation = obs[0]
    assert other_value == "774451201"
    assert observation.module == "telegram_uid"


def test_tt_non_numeric_value_maps_to_co_mention():
    result = sm.SearchResult(
        module_id="tt", query="email:x@y.com", total=1, cost=0,
        records=[], identifiers=[{"type": "domain", "value": "shadyforum.example", "field": "value", "at": None}],
    )
    obs = sm.to_observations("tt", "x@y.com", result)
    assert len(obs) == 1
    _, _, observation = obs[0]
    assert observation.module == "co_mention"


def test_to_observations_excludes_the_seed_itself():
    result = sm.SearchResult(
        module_id="cds", query="email:x@y.com", total=1, cost=50,
        records=[], identifiers=[{"type": "email", "value": "x@y.com", "field": "user", "at": None}],
    )
    assert sm.to_observations("cds", "x@y.com", result) == []
