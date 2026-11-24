#!/usr/bin/env bash
# list-services.sh
# Lists all onboarded services and their status from the cluster.
# Reads only from the cluster — no hardcoded service names.

set -euo pipefail

APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

main() {
  header "Onboarded Services — namespace: $APPS_NAMESPACE"
  echo ""

  # Deployments
  kubectl get deployments -n "$APPS_NAMESPACE" \
    -o custom-columns=\
"NAME:.metadata.name,\
READY:.status.readyReplicas,\
DESIRED:.spec.replicas,\
IMAGE:.spec.template.spec.containers[0].image,\
AGE:.metadata.creationTimestamp" \
    2>/dev/null || echo "  (none)"

  echo ""
  header "Services"
  kubectl get services -n "$APPS_NAMESPACE" \
    -o custom-columns=\
"NAME:.metadata.name,\
TYPE:.spec.type,\
CLUSTER-IP:.spec.clusterIP,\
PORT:.spec.ports[0].port,\
AGE:.metadata.creationTimestamp" \
    2>/dev/null || echo "  (none)"

  echo ""
  header "Onboarding configs (local)"
  local conf_dir="${MANIFESTS_DIR:-./manifests}"
  if ls "$conf_dir"/*.onboard.conf 2>/dev/null | grep -q .; then
    for f in "$conf_dir"/*.onboard.conf; do
      local name repo branch build_method
      # shellcheck source=/dev/null
      source "$f"
      echo "  → $SERVICE_NAME  |  $REPO_URL @ $BRANCH  |  build: $BUILD_METHOD  |  db: $DB_MODE"
    done
  else
    echo "  No .onboard.conf files found in $conf_dir"
  fi
  echo ""
}

main "$@"
