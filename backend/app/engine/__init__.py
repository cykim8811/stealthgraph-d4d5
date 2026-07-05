"""STEALTHGRAPH inference engine.

Pure, dependency-free probability machinery that turns fragmented
identifiers into a *derived* view of who-is-who — without ever storing a
"merge". Everything here is deterministic and side-effect free so the
same query always yields the same graph.

Layers:
    modules  — the evidence-module registry (weight + forgeability)
    fusion   — log-odds fusion of module observations into P(same_entity)
    dataset  — the in-memory demo corpus (nodes + timestamped observations)
    graph    — bounded BFS, edge breakdown, timeline bounds
"""
