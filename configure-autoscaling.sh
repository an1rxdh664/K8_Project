#!/usr/bin/env bash
# configure-autoscaling.sh
# Generates a KEDA ScaledObject for an onboarded service.
# All values come from the .onboard.conf and CLI flags — nothing hardcoded.
#
# Supported trigger types:
#   cpu        — scale on CPU utilisation (default)
#   http       — scale on HTTP request rate (requires KEDA HTTP Add-on)
#   memory     — scale on memory utilisation
#   cron       — scale on a cron schedule
#
# Usage:
#   ./configure-autoscaling.sh <service.onboard.conf> [OPTIONS]
#   ./configure-autoscaling.sh --help

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

CONF_FILE=""
TRIGGER_TYPE="${TRIGGER_TYPE:-cpu}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-10}"
# CPU trigger
CPU_TARGET="${CPU_TARGET:-70}"          # % utilisation
# Memory trigger
MEM_TARGET="${MEM_TARGET:-80}"          # % utilisation
# HTTP trigger (KEDA HTTP add-on)
HTTP_TARGET="${HTTP_TARGET:-100}"       # requests per second
HTTP_SERVICE_PORT="${HTTP_SERVICE_PORT:-80}"
# Cron trigger
CRON_TIMEZONE="${CRON_TIMEZONE:-UTC}"
CRON_START="${CRON_START:-0 9 * * 1-5}"   # weekdays 9am
CRON_END="${CRON_END:-0 18 * * 1-5}"      # weekdays 6pm
CRON_DESIRED="${CRON_DESIRED:-3}"
SCALE_DOWN_STABILIZATION="${SCALE_DOWN_STABILIZATION:-300}"  # seconds
APPLY="${APPLY:-true}"
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"

usage() {
  cat <<EOF
${BOLD}configure-autoscaling.sh${NC} — Generate KEDA ScaledObject for a service

${BOLD}Usage:${NC}
  ./configure-autoscaling.sh <service.onboard.conf> [OPTIONS]

${BOLD}Options:${NC}
  --trigger     cpu | http | memory | cron   (default: cpu)
  --min         Minimum replicas              (default: 1)
  --max         Maximum replicas              (default: 10)
  --no-apply    Generate YAML only, don't apply

${BOLD}Trigger-specific options:${NC}
  CPU/Memory:
    --cpu-target  <percent>   CPU % to trigger scale-up (default: 70)
    --mem-target  <percent>   Memory % to trigger scale-up (default: 80)
  HTTP:
    --http-target <rps>       Requests/sec per replica (default: 100)
  Cron:
    --cron-tz      <timezone> Timezone (default: UTC)
    --cron-start   <expr>     Scale-up cron expression (default: 0 9 * * 1-5)
    --cron-end     <expr>     Scale-down cron expression (default: 0 18 * * 1-5)
    --cron-desired <n>        Desired replicas during window (default: 3)

${BOLD}Environment variables:${NC}
  All options above can be set as TRIGGER_TYPE, MIN_REPLICAS, MAX_REPLICAS, etc.
EOF
  exit 0
}

parse_args() {
  [[ $# -eq 0 ]] && die "Usage: ./configure-autoscaling.sh <service.onboard.conf> [OPTIONS]"
  CONF_FILE="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --trigger)      TRIGGER_TYPE="$2";   shift 2 ;;
      --min)          MIN_REPLICAS="$2";   shift 2 ;;
      --max)          MAX_REPLICAS="$2";   shift 2 ;;
      --cpu-target)   CPU_TARGET="$2";     shift 2 ;;
      --mem-target)   MEM_TARGET="$2";     shift 2 ;;
      --http-target)  HTTP_TARGET="$2";    shift 2 ;;
      --cron-tz)      CRON_TIMEZONE="$2";  shift 2 ;;
      --cron-start)   CRON_START="$2";     shift 2 ;;
      --cron-end)     CRON_END="$2";       shift 2 ;;
      --cron-desired) CRON_DESIRED="$2";   shift 2 ;;
      --no-apply)     APPLY="false";       shift ;;
      --help|-h)      usage ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

load_config() {
  [[ -f "$CONF_FILE" ]] || die "Config not found: $CONF_FILE"
  # shellcheck source=/dev/null
  source "$CONF_FILE"
  for var in SERVICE_NAME APPS_NAMESPACE; do
    [[ -n "${!var:-}" ]] || die "Config missing: $var"
  done
  APPS_NAMESPACE="${APPS_NAMESPACE}"
}

# ── Trigger YAML blocks ───────────────────────────────────────────────────────

trigger_cpu() {
  cat <<EOF
  - type: cpu
    metricType: Utilization
    metadata:
      value: "${CPU_TARGET}"
EOF
}

trigger_memory() {
  cat <<EOF
  - type: memory
    metricType: Utilization
    metadata:
      value: "${MEM_TARGET}"
EOF
}

trigger_http() {
  cat <<EOF
  - type: http
    metadata:
      url: "http://${SERVICE_NAME}.${APPS_NAMESPACE}.svc.cluster.local:${HTTP_SERVICE_PORT}/"
      targetPendingRequests: "${HTTP_TARGET}"
EOF
}

trigger_cron() {
  cat <<EOF
  - type: cron
    metadata:
      timezone: ${CRON_TIMEZONE}
      start: "${CRON_START}"
      end:   "${CRON_END}"
      desiredReplicas: "${CRON_DESIRED}"
EOF
}

get_trigger_block() {
  case "$TRIGGER_TYPE" in
    cpu)    trigger_cpu ;;
    memory) trigger_memory ;;
    http)   trigger_http ;;
    cron)   trigger_cron ;;
    *) die "Unknown trigger type: $TRIGGER_TYPE (cpu | memory | http | cron)" ;;
  esac
}

# ── Generate ScaledObject ─────────────────────────────────────────────────────
gen_scaledobject() {
  local out_dir
  out_dir="$(dirname "$CONF_FILE")/${SERVICE_NAME}"
  mkdir -p "$out_dir"

  local trigger_yaml
  trigger_yaml=$(get_trigger_block)

  cat > "$out_dir/07-scaledobject.yaml" <<EOF
# 07-scaledobject.yaml — KEDA ScaledObject for $SERVICE_NAME
# Generated by configure-autoscaling.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Trigger: $TRIGGER_TYPE | min: $MIN_REPLICAS | max: $MAX_REPLICAS
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ${SERVICE_NAME}
  namespace: ${APPS_NAMESPACE}
  labels:
    app.kubernetes.io/name: ${SERVICE_NAME}
    app.kubernetes.io/part-of: k8s-platform
    app.kubernetes.io/managed-by: platform
  annotations:
    platform/trigger-type: "${TRIGGER_TYPE}"
    platform/min-replicas: "${MIN_REPLICAS}"
    platform/max-replicas: "${MAX_REPLICAS}"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${SERVICE_NAME}
  minReplicaCount: ${MIN_REPLICAS}
  maxReplicaCount: ${MAX_REPLICAS}
  cooldownPeriod: ${SCALE_DOWN_STABILIZATION}
  pollingInterval: 15
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: ${SCALE_DOWN_STABILIZATION}
          policies:
            - type: Percent
              value: 50
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Percent
              value: 100
              periodSeconds: 30
  triggers:
${trigger_yaml}
EOF

  info "Generated: $out_dir/07-scaledobject.yaml"
  echo "$out_dir/07-scaledobject.yaml"
}

apply_scaledobject() {
  local manifest="$1"
  if [[ "$APPLY" == "true" ]]; then
    kubectl apply -f "$manifest"
    success "ScaledObject applied for $SERVICE_NAME"
  else
    info "Skipping apply (--no-apply). Apply manually:"
    echo "  kubectl apply -f $manifest"
  fi
}

remove_autoscaling() {
  local name="$1"
  info "Removing ScaledObject for $name"
  kubectl delete scaledobject "$name" -n "$APPS_NAMESPACE" --ignore-not-found
  success "Autoscaling removed for $name"
  warn "Deployment replicas may be stuck at KEDA's last value. Reset:"
  echo "  kubectl scale deployment/$name -n $APPS_NAMESPACE --replicas=1"
}

print_summary() {
  local manifest="$1"
  header "Autoscaling configured — $SERVICE_NAME"
  echo ""
  echo "  Trigger : $TRIGGER_TYPE"
  echo "  Replicas: $MIN_REPLICAS → $MAX_REPLICAS"
  echo "  Manifest: $manifest"
  echo ""
  echo "  Check status:"
  echo "    kubectl get scaledobject $SERVICE_NAME -n $APPS_NAMESPACE"
  echo "    kubectl get hpa -n $APPS_NAMESPACE"
  echo ""
  echo "  Remove autoscaling:"
  echo "    kubectl delete scaledobject $SERVICE_NAME -n $APPS_NAMESPACE"
}

main() {
  case "${1:-}" in
    --help|-h) usage ;;
  esac

  parse_args "$@"
  header "Kubernetes Platform — KEDA Autoscaling"
  load_config

  local manifest
  manifest=$(gen_scaledobject)
  apply_scaledobject "$manifest"
  print_summary "$manifest"
}

main "$@"
