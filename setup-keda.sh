#!/usr/bin/env bash
# setup-keda.sh
# Installs KEDA (Kubernetes Event-Driven Autoscaling) into the cluster.
# Nothing about any specific service is hardcoded here.
#
# Usage:
#   ./setup-keda.sh
#   ./setup-keda.sh --version 2.15.1

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

KEDA_NAMESPACE="${KEDA_NAMESPACE:-keda}"
KEDA_VERSION="${KEDA_VERSION:-2.15.1}"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) KEDA_VERSION="$2"; shift 2 ;;
      --help|-h)
        echo "Usage: ./setup-keda.sh [--version <version>]"
        echo "  Default version: $KEDA_VERSION"
        exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

install_via_helm() {
  if ! command -v helm &>/dev/null; then
    return 1
  fi
  info "Installing KEDA $KEDA_VERSION via Helm"
  helm repo add kedacore https://kedacore.github.io/charts 2>/dev/null || true
  helm repo update kedacore
  helm upgrade --install keda kedacore/keda \
    --namespace "$KEDA_NAMESPACE" \
    --create-namespace \
    --version "$KEDA_VERSION" \
    --set watchNamespace="apps" \
    --wait \
    --timeout 180s
  return 0
}

install_via_manifest() {
  info "Installing KEDA $KEDA_VERSION via manifest (helm not found)"
  local manifest_url="https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml"
  kubectl apply -f "$manifest_url"
  info "Waiting for KEDA operator to be ready..."
  kubectl rollout status deployment/keda-operator \
    -n "$KEDA_NAMESPACE" \
    --timeout=180s
}

install_keda() {
  if kubectl get namespace "$KEDA_NAMESPACE" &>/dev/null; then
    if kubectl get deployment keda-operator -n "$KEDA_NAMESPACE" &>/dev/null; then
      info "KEDA already installed — skipping"
      return
    fi
  fi

  install_via_helm || install_via_manifest
  success "KEDA $KEDA_VERSION installed"
}

verify_keda() {
  info "Verifying KEDA CRDs..."
  local required_crds=("scaledobjects.keda.sh" "scaledjobs.keda.sh" "triggerauthentications.keda.sh")
  local missing=()
  for crd in "${required_crds[@]}"; do
    kubectl get crd "$crd" &>/dev/null || missing+=("$crd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "Missing CRDs: ${missing[*]} — KEDA may still be initialising"
  else
    success "All KEDA CRDs present"
  fi
}

print_summary() {
  header "KEDA ready"
  echo ""
  echo "  Namespace : $KEDA_NAMESPACE"
  echo "  Version   : $KEDA_VERSION"
  echo "  Watching  : apps namespace"
  echo ""
  echo "  Add autoscaling to a service:"
  echo "    ./configure-autoscaling.sh manifests/<service>.onboard.conf"
  echo ""
  echo "  List ScaledObjects:"
  echo "    kubectl get scaledobjects -n apps"
}

main() {
  parse_args "$@"
  header "Kubernetes Platform — KEDA Setup"
  install_keda
  verify_keda
  print_summary
}

main "$@"
