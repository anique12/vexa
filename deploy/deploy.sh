#!/usr/bin/env bash
# CI deploy for the Hetzner Vexa docker-compose stack.
#
#   Invoked by .github/workflows/deploy.yml via a command-restricted SSH key whose
#   authorized_keys entry forces: `cd /root/vexa && bash deploy/deploy.sh`.
#
# Strategy: hard-sync origin/main, then rebuild + recreate ONLY the services whose
# code changed in the push (skips the slow 6.3GB bot image unless services/vexa-bot
# changed). Everything runs on the :latest tag. .env is gitignored, so the box's
# BROWSER_IMAGE / IMAGE_TAG / secrets survive the git reset.
#
# Safety: never rebuild/restart while a meeting bot (meeting-<id>-<hash>) is live.
set -euo pipefail
ROOT=/root/vexa
cd "$ROOT"
export IMAGE_TAG=latest
COMPOSE=(docker compose --env-file "$ROOT/.env"
         -f "$ROOT/deploy/compose/docker-compose.yml"
         -f "$ROOT/deploy/compose/docker-compose.override.yml")

before=$(git rev-parse HEAD)
git fetch --quiet origin main
git reset --hard origin/main
after=$(git rev-parse HEAD)
echo "vexa-deploy: ${before:0:7} -> ${after:0:7}"
if [ "$before" = "$after" ]; then echo "already up to date"; exit 0; fi

if docker ps --format '{{.Names}}' | grep -qE '^meeting-[0-9]'; then
  echo "WARNING: a meeting bot is LIVE -> skipping deploy; re-run when clear"
  exit 0
fi

changed=$(git diff --name-only "$before" "$after")
echo "changed files:"; echo "$changed" | sed 's/^/  /'

declare -A SVC; BOT=0; DASH=0; ALL=0; CONFIG=0
while IFS= read -r f; do
  case "$f" in
    services/vexa-bot/*)            BOT=1 ;;
    services/api-gateway/*)         SVC[api-gateway]=1 ;;
    services/admin-api/*)           SVC[admin-api]=1 ;;
    services/runtime-api/*)         SVC[runtime-api]=1 ;;
    services/meeting-api/*)         SVC[meeting-api]=1 ;;
    services/mcp/*)                 SVC[mcp]=1 ;;
    services/tts-service/*)         SVC[tts-service]=1 ;;
    services/dashboard/*)           DASH=1; SVC[dashboard]=1 ;;
    packages/transcript-rendering/*) DASH=1; SVC[dashboard]=1 ;;
    libs/*|packages/*)              ALL=1 ;;   # shared code -> rebuild all
    deploy/compose/*)               CONFIG=1 ;;
    *) ;;                                        # docs etc -> ignore
  esac
done <<< "$changed"

# Shared libs changed -> full rebuild via the Makefile, retag build-tag -> :latest.
if [ "$ALL" = 1 ]; then
  echo "shared libs changed -> full rebuild"
  make -C deploy/compose build
  TAG=$(cat deploy/compose/.last-tag)
  for img in api-gateway admin-api runtime-api meeting-api mcp dashboard tts-service vexa-lite vexa-bot; do
    docker tag "vexaai/$img:$TAG" "vexaai/$img:latest"
  done
  rm -f deploy/compose/.last-tag
  "${COMPOSE[@]}" up -d
  echo "vexa-deploy done (full rebuild)"; exit 0
fi

# The dashboard image bakes in the host-built transcript-rendering package.
if [ "$DASH" = 1 ]; then
  echo "building transcript-rendering package (host)"
  ( cd packages/transcript-rendering && npm install && npm run build )
fi

# The bot is spawned per-meeting from BROWSER_IMAGE (=:latest), not a compose service.
if [ "$BOT" = 1 ]; then
  echo "rebuilding bot image :latest"
  docker build --platform linux/amd64 -t vexaai/vexa-bot:latest \
    -f services/vexa-bot/Dockerfile services/vexa-bot
fi

# Rebuild + recreate the changed compose services.
if [ "${#SVC[@]}" -gt 0 ]; then
  svcs="${!SVC[*]}"
  echo "rebuilding + recreating: $svcs"
  "${COMPOSE[@]}" build $svcs
  "${COMPOSE[@]}" up -d $svcs
fi

# Config-only change (compose/override/profiles/Caddyfile) -> apply to the stack.
if [ "$CONFIG" = 1 ]; then
  echo "applying compose/config changes"
  "${COMPOSE[@]}" up -d
fi

if [ "$BOT" = 0 ] && [ "${#SVC[@]}" -eq 0 ] && [ "$CONFIG" = 0 ]; then
  echo "no deployable service/config changes in this push"
fi
echo "vexa-deploy done"
