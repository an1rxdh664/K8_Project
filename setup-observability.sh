#!/usr/bin/env bash
# setup-observability.sh
# Installs Prometheus + Grafana into the observability namespace.
# Uses kube-prometheus-stack (Helm) — includes Prometheus Operator,
# Alertmanager, node-exporter, kube-state-metrics, and Grafana.
# Nothing about any specific service is hardcoded here.
#
# Usage:
#   ./setup-observability.sh
#   ./setup-observability.sh --port-forward   # keeps both port-forwards running

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

OBS_NAMESPACE="${OBS_NAMESPACE:-observability}"
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
STACK_VERSION="${PROM_STACK_VERSION:-}"   # empty = latest
PROMETHEUS_PORT="${PROMETHEUS_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3000}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD:-platform-local}"
PORT_FORWARD="${PORT_FORWARD:-false}"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port-forward)   PORT_FORWARD="true";       shift ;;
      --version)        STACK_VERSION="$2";         shift 2 ;;
      --grafana-pass)   GRAFANA_PASSWORD="$2";      shift 2 ;;
      --help|-h)
        echo "Usage: ./setup-observability.sh [--port-forward] [--version <chart-version>] [--grafana-pass <pass>]"
        exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

check_helm() {
  command -v helm &>/dev/null || die "helm is required. Install: https://helm.sh/docs/intro/install/"
}

install_prometheus_stack() {
  if kubectl get deployment prometheus-grafana -n "$OBS_NAMESPACE" &>/dev/null; then
    info "Prometheus stack already installed — skipping"
    return
  fi

  info "Adding prometheus-community Helm repo"
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo update prometheus-community

  local version_flag=""
  [[ -n "$STACK_VERSION" ]] && version_flag="--version $STACK_VERSION"

  info "Installing kube-prometheus-stack → namespace $OBS_NAMESPACE"
  # shellcheck disable=SC2086
  helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    --namespace "$OBS_NAMESPACE" \
    --create-namespace \
    $version_flag \
    --set grafana.adminPassword="$GRAFANA_PASSWORD" \
    --set grafana.defaultDashboardsEnabled=true \
    --set grafana.sidecar.dashboards.enabled=true \
    --set grafana.sidecar.dashboards.label=grafana_dashboard \
    --set grafana.sidecar.datasources.enabled=true \
    --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
    --set prometheus.prometheusSpec.serviceMonitorNamespaceSelector.matchExpressions[0].key=kubernetes.io/metadata.name \
    --set prometheus.prometheusSpec.serviceMonitorNamespaceSelector.matchExpressions[0].operator=In \
    "--set prometheus.prometheusSpec.serviceMonitorNamespaceSelector.matchExpressions[0].values={${APPS_NAMESPACE},${OBS_NAMESPACE}}" \
    --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
    --set alertmanager.enabled=false \
    --set nodeExporter.enabled=true \
    --set kubeStateMetrics.enabled=true \
    --wait \
    --timeout=300s

  success "kube-prometheus-stack installed"
}

apply_platform_dashboard() {
  info "Applying Grafana platform dashboard ConfigMap"
  kubectl apply -f grafana-dashboard.yaml
  success "Platform dashboard ConfigMap applied"
}

apply_obs_rbac() {
  info "Applying observability RBAC"
  kubectl apply -f observability-rbac.yaml
}

start_port_forwards() {
  info "Starting Prometheus port-forward: localhost:${PROMETHEUS_PORT} → prometheus:9090"
  kubectl port-forward svc/prometheus-kube-prometheus-prometheus \
    -n "$OBS_NAMESPACE" \
    "${PROMETHEUS_PORT}:9090" &>/dev/null &
  sleep 1

  info "Starting Grafana port-forward: localhost:${GRAFANA_PORT} → grafana:80"
  kubectl port-forward svc/prometheus-grafana \
    -n "$OBS_NAMESPACE" \
    "${GRAFANA_PORT}:80" &>/dev/null &
  sleep 1

  success "Port-forwards started"
}

print_summary() {
  header "Observability stack ready"
  echo ""
  echo "  Namespace  : $OBS_NAMESPACE"
  echo ""
  echo "  Prometheus : kubectl port-forward svc/prometheus-kube-prometheus-prometheus -n $OBS_NAMESPACE ${PROMETHEUS_PORT}:9090"
  echo "               → http://localhost:${PROMETHEUS_PORT}"
  echo ""
  echo "  Grafana    : kubectl port-forward svc/prometheus-grafana -n $OBS_NAMESPACE ${GRAFANA_PORT}:80"
  echo "               → http://localhost:${GRAFANA_PORT}"
  echo "               Login: admin / $GRAFANA_PASSWORD"
  echo ""
  echo "  Add monitoring to a service:"
  echo "    ./configure-monitoring.sh manifests/<service>.onboard.conf"
}

main() {
  parse_args "$@"
  header "Kubernetes Platform — Observability Setup"
  check_helm
  install_prometheus_stack
  apply_platform_dashboard
  apply_obs_rbac

  if [[ "$PORT_FORWARD" == "true" ]]; then
    start_port_forwards
  fi

  print_summary
}

main "$@"
