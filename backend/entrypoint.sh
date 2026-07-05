#!/bin/sh
set -e

# Wait up to 60s for Postgres to accept TCP — the coders.kr platform
# brings the StatefulSet up in parallel with the build, so the very
# first container start can race readiness.
if [ -n "${DATABASE_URL:-}" ]; then
  host="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^:/]+).*#\1#')"
  port="$(printf '%s' "$DATABASE_URL" | sed -nE 's#.*@[^:]+:([0-9]+).*#\1#p')"
  port="${port:-5432}"
  if [ -n "$host" ]; then
    i=0
    while [ "$i" -lt 60 ] && ! (echo > "/dev/tcp/${host}/${port}") 2>/dev/null; do
      i=$((i+1)); sleep 1
    done
  fi
fi

uv run alembic upgrade head

exec uv run uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
