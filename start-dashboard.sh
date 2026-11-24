#!/usr/bin/env bash
# start-dashboard.sh — Starts the Platform Dashboard (backend + frontend)
#
# Usage:
#   ./start-dashboard.sh [--port-frontend 3000] [--port-backend 3001] [--dev]
#
# Environment:
#   FRONTEND_PORT   default 3000
#   BACKEND_PORT    default 3001
#   KUBECONFIG      path to kubeconfig (default: ~/.kube/config)
#   CLUSTER_NAME    name of the k3d/kind cluster
#   PLATFORM_NS     default: platform
#   APPS_NS         default: apps
#   OBS_NS          default: observability
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"
BACKEND_DIR="${SCRIPT_DIR}/backend"

FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
DEV_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port-frontend) FRONTEND_PORT="$2"; shift 2 ;;
    --port-backend)  BACKEND_PORT="$2";  shift 2 ;;
    --dev)           DEV_MODE=true;      shift   ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: node not found. Install Node.js 18+." >&2; exit 1
fi
if ! command -v npm &>/dev/null; then
  echo "ERROR: npm not found." >&2; exit 1
fi
if ! command -v kubectl &>/dev/null; then
  echo "WARNING: kubectl not found — API calls will fail." >&2
fi

# ── Install dependencies ─────────────────────────────────────────────────────
echo "→ Installing backend dependencies…"
(cd "${BACKEND_DIR}" && npm install --silent)

echo "→ Installing frontend dependencies…"
(cd "${FRONTEND_DIR}" && npm install --silent)

# ── Build frontend (production) ───────────────────────────────────────────────
if [[ "${DEV_MODE}" == false ]]; then
  echo "→ Building frontend…"
  (cd "${FRONTEND_DIR}" && BACKEND_URL="http://localhost:${BACKEND_PORT}" npm run build)
fi

# ── Start backend ─────────────────────────────────────────────────────────────
echo "→ Starting backend on :${BACKEND_PORT}…"
(
  cd "${BACKEND_DIR}"
  export PORT="${BACKEND_PORT}"
  node server.js
) &
BACKEND_PID=$!

# Give the backend a moment to start
sleep 1

# ── Start frontend ────────────────────────────────────────────────────────────
echo "→ Starting frontend on :${FRONTEND_PORT}…"
(
  cd "${FRONTEND_DIR}"
  export BACKEND_URL="http://localhost:${BACKEND_PORT}"
  if [[ "${DEV_MODE}" == true ]]; then
    npm run dev -- -p "${FRONTEND_PORT}"
  else
    npm start -- -p "${FRONTEND_PORT}"
  fi
) &
FRONTEND_PID=$!

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Platform Dashboard running                 ║"
echo "║   Frontend → http://localhost:${FRONTEND_PORT}          ║"
echo "║   Backend  → http://localhost:${BACKEND_PORT}          ║"
echo "║   Press Ctrl+C to stop                       ║"
echo "╚══════════════════════════════════════════════╝"

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "Stopping dashboard…"
  kill "${BACKEND_PID}"  2>/dev/null || true
  kill "${FRONTEND_PID}" 2>/dev/null || true
  wait "${BACKEND_PID}"  2>/dev/null || true
  wait "${FRONTEND_PID}" 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

wait
