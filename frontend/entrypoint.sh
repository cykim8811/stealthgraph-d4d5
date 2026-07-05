#!/bin/sh
set -e

# Pull the cluster DNS server from /etc/resolv.conf and hand it to the
# nginx template as ${NGINX_RESOLVER}. Inside Kubernetes this is
# kube-dns; locally (docker compose etc.) it'll be the docker DNS.
export NGINX_RESOLVER="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)"

# Hand control to the official nginx entrypoint, which runs envsubst on
# /etc/nginx/templates/*.template and then `exec` into nginx itself.
exec /docker-entrypoint.sh "$@"
