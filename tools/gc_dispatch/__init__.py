"""Ground Control host-wide verification resource dispatcher (GC-O016, ADR-096).

A daemonless, per-user CPU admission wrapper for the verification commands a
repository already declares in `.ground-control.yaml`. Installed as a real host
copy by `bin/install-ground-control.sh`, so it must never import from a
checkout's `node_modules` or from the MCP server.
"""
