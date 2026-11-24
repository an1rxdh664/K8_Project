#!/usr/bin/env bash
# teardown-cluster.sh
# Destroys the local cluster and registry created by setup-cluster.sh.
# Safe to run multiple times.

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-k8s-platform}"
REGISTRY_NAME="${REGISTRY_NAME:-platform-registry}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${RED}[WARN]${NC}  $*"; }

main() {
  if command -v k3d &>/dev/null; then
    if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER_NAME}"; then
      info "Deleting k3d cluster $CLUSTER_NAME"
      k3d cluster delete "$CLUSTER_NAME"
    else
      info "k3d cluster $CLUSTER_NAME not found — skipping"
    fi

    if k3d registry list 2>/dev/null | grep -q "$REGISTRY_NAME"; then
      info "Deleting k3d registry $REGISTRY_NAME"
      k3d registry delete "$REGISTRY_NAME"
    else
      info "k3d registry $REGISTRY_NAME not found — skipping"
    fi

  elif command -v kind &>/dev/null; then
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
      info "Deleting kind cluster $CLUSTER_NAME"
      kind delete cluster --name "$CLUSTER_NAME"
    else
      info "kind cluster $CLUSTER_NAME not found — skipping"
    fi

    if docker ps --format '{{.Names}}' | grep -q "^kind-registry$"; then
      info "Stopping kind registry container"
      docker rm -f kind-registry
    fi
  else
    warn "Neither k3d nor kind found — nothing to delete"
  fi

  success "Teardown complete"
}

main "$@"
