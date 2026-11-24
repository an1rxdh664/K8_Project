#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
DEV_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)             DEV_MODE=true;      shift   ;;
    --frontend-port)   FRONTEND_PORT="$2"; shift 2 ;;
    --backend-port)    BACKEND_PORT="$2";  shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

echo ""; echo "Step 1/2 — Setting up Kubernetes cluster"
bash "${SCRIPT_DIR}/setup-cluster.sh"

echo ""; echo "Step 2/2 — Launching platform dashboard"
LAUNCH_ARGS=("--port-frontend" "$FRONTEND_PORT" "--port-backend" "$BACKEND_PORT")
[[ "$DEV_MODE" == true ]] && LAUNCH_ARGS+=("--dev")
export FRONTEND_PORT BACKEND_PORT
bash "${SCRIPT_DIR}/start-dashboard.sh" "${LAUNCH_ARGS[@]}"