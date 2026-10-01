#!/usr/bin/env bash
# Generates wrangler.toml from .env, then deploys.
# Keeps D1/R2 resource IDs out of git. SNAPZ_TOKEN stays a Cloudflare secret.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing api/.env — copy .env.example and fill it in."; exit 1; }
set -a; . ./.env; set +a

: "${D1_DATABASE_ID:?set D1_DATABASE_ID in .env}"
: "${D1_DATABASE_NAME:=snapz}"
: "${R2_BUCKET:?set R2_BUCKET in .env}"
: "${R2_PUBLIC_BASE:=}"

sed -e "s|\${D1_DATABASE_ID}|${D1_DATABASE_ID}|g" \
    -e "s|\${D1_DATABASE_NAME}|${D1_DATABASE_NAME}|g" \
    -e "s|\${R2_BUCKET}|${R2_BUCKET}|g" \
    -e "s|\${R2_PUBLIC_BASE}|${R2_PUBLIC_BASE}|g" \
    wrangler.toml.example > wrangler.toml

echo "✓ wrangler.toml generated (git-ignored)"
exec wrangler deploy "$@"
