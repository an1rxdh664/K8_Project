#!/usr/bin/env bash
# setup-argocd.sh
# Installs ArgoCD into the cluster and configures it for the platform.
# Nothing about any specific service is hardcoded here.
#
# Usage:
#   ./setup-argocd.sh
#   ./setup-argocd.sh --port-forward   # keeps port-forward running after install

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

ARGOCD_NAMESPACE="${ARGOCD_NAMESPACE:-argocd}"
ARGOCD_VERSION="${ARGOCD_VERSION:-stable}"   # 'stable' resolves to latest stable release
ARGOCD_PORT="${ARGOCD_PORT:-8080}"
PORT_FORWARD="${PORT_FORWARD:-false}"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port-forward) PORT_FORWARD="true"; shift ;;
      --version)      ARGOCD_VERSION="$2"; shift 2 ;;
      --help|-h)
        echo "Usage: ./setup-argocd.sh [--port-forward] [--version <tag>]"
        exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

install_argocd() {
  # Create namespace
  kubectl get namespace "$ARGOCD_NAMESPACE" &>/dev/null \
    || kubectl create namespace "$ARGOCD_NAMESPACE"

  # Install ArgoCD
  local manifest_url
  if [[ "$ARGOCD_VERSION" == "stable" ]]; then
    manifest_url="https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml"
  else
    manifest_url="https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"
  fi

  info "Installing ArgoCD ($ARGOCD_VERSION) → namespace $ARGOCD_NAMESPACE"
  kubectl apply -n "$ARGOCD_NAMESPACE" -f "$manifest_url"

  info "Waiting for ArgoCD server to be ready (this may take ~2 minutes)..."
  kubectl rollout status deployment/argocd-server \
    -n "$ARGOCD_NAMESPACE" \
    --timeout=180s
  success "ArgoCD server ready"
}

patch_argocd_insecure() {
  # For local dev: disable TLS on the server so we can port-forward without cert issues
  info "Patching ArgoCD server for local access (--insecure)"
  kubectl patch deployment argocd-server \
    -n "$ARGOCD_NAMESPACE" \
    --type='json' \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--insecure"}]' \
    2>/dev/null || warn "Could not patch argocd-server — may already be patched"

  kubectl rollout status deployment/argocd-server \
    -n "$ARGOCD_NAMESPACE" \
    --timeout=60s
}

apply_platform_rbac() {
  info "Applying ArgoCD platform RBAC"
  kubectl apply -f argocd-rbac.yaml
}

get_initial_password() {
  local password
  password=$(kubectl -n "$ARGOCD_NAMESPACE" get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" 2>/dev/null | base64 -d 2>/dev/null || echo "")

  if [[ -n "$password" ]]; then
    success "ArgoCD initial admin password retrieved"
    echo ""
    echo "  ⚠️  Change this password after first login:"
    echo "  Username : admin"
    echo "  Password : $password"
    echo ""
  else
    warn "Could not retrieve initial password — secret may not exist yet"
    echo "  Retrieve manually: kubectl -n $ARGOCD_NAMESPACE get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
  fi
}

start_port_forward() {
  info "Starting port-forward: localhost:${ARGOCD_PORT} → argocd-server:80"
  kubectl port-forward svc/argocd-server \
    -n "$ARGOCD_NAMESPACE" \
    "${ARGOCD_PORT}:80" &
  PF_PID=$!
  sleep 2
  if kill -0 "$PF_PID" 2>/dev/null; then
    success "Port-forward running (PID $PF_PID)"
    echo "  ArgoCD UI: http://localhost:${ARGOCD_PORT}"
  else
    warn "Port-forward may have failed — start manually:"
    echo "  kubectl port-forward svc/argocd-server -n $ARGOCD_NAMESPACE ${ARGOCD_PORT}:80"
  fi
}

print_summary() {
  header "ArgoCD ready"
  echo ""
  echo "  Namespace : $ARGOCD_NAMESPACE"
  echo "  UI        : kubectl port-forward svc/argocd-server -n $ARGOCD_NAMESPACE ${ARGOCD_PORT}:80"
  echo "              then open http://localhost:${ARGOCD_PORT}"
  echo ""
  echo "  Register a service with ArgoCD:"
  echo "    ./gitops-register.sh manifests/<service>.onboard.conf"
  echo ""
  echo "  List ArgoCD apps:"
  echo "    kubectl get applications -n $ARGOCD_NAMESPACE"
}

main() {
  parse_args "$@"
  header "Kubernetes Platform — ArgoCD Setup"

  install_argocd
  patch_argocd_insecure
  apply_platform_rbac
  get_initial_password

  if [[ "$PORT_FORWARD" == "true" ]]; then
    start_port_forward
  fi

  print_summary
}

main "$@"
