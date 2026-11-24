#!/usr/bin/env bash
# run-migration.sh
# Runs an expand-contract database migration for an onboarded service.
# Migrations execute as Kubernetes Jobs — no long-lived migration containers.
# Results are stored in a ConfigMap for the dashboard to read.
#
# Expand-contract pattern:
#   Phase 1 — EXPAND:   Add new columns/tables (backward compatible). Old code still runs.
#   Phase 2 — VERIFY:   Run checks to confirm expand succeeded before proceeding.
#   Phase 3 — CONTRACT: Remove old columns/tables once all pods run new code.
#
# Usage:
#   ./run-migration.sh <service.onboard.conf> --phase expand
#   ./run-migration.sh <service.onboard.conf> --phase verify
#   ./run-migration.sh <service.onboard.conf> --phase contract
#   ./run-migration.sh <service.onboard.conf> --phase all   # expand→verify→contract in sequence
#   ./run-migration.sh --history <service-name>

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

CONF_FILE=""
PHASE=""           # expand | verify | contract | all
MIGRATION_ID=""    # auto-generated from timestamp if not supplied
MIGRATION_IMAGE="" # image to run migration; defaults to service image
JOB_TIMEOUT="${JOB_TIMEOUT:-300}"          # seconds to wait for Job to complete
HISTORY_SERVICE=""
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-platform}"
DRY_RUN="${DRY_RUN:-false}"

usage() {
  cat <<EOF
${BOLD}run-migration.sh${NC} — Run expand-contract migrations as Kubernetes Jobs

${BOLD}Usage:${NC}
  ./run-migration.sh <service.onboard.conf> --phase <phase>
  ./run-migration.sh --history <service-name>

${BOLD}Phases:${NC}
  expand    Add new schema (backward-compatible). Safe to run while old code runs.
  verify    Assert expand succeeded. Blocks contract if it fails.
  contract  Remove old schema. Only safe after all pods run new code.
  all       Run expand → verify → contract in sequence with confirmation prompts.

${BOLD}Options:${NC}
  --phase     <phase>    Phase to run (required)
  --id        <id>       Migration ID (default: timestamp)
  --image     <image>    Migration image override (default: service image)
  --timeout   <seconds>  Job timeout (default: 300)
  --dry-run              Print Job YAML without applying
  --history   <service>  Show migration history for a service

${BOLD}How migrations are invoked:${NC}
  The Job runs the service image with an entrypoint override.
  Your service must support these commands (configure via your Dockerfile/Procfile):
    migrate-expand    — run expand phase
    migrate-verify    — run verify phase
    migrate-contract  — run contract phase
  Set custom commands via MIGRATION_CMD_EXPAND/VERIFY/CONTRACT env vars before calling.

${BOLD}Example:${NC}
  MIGRATION_CMD_EXPAND="python manage.py migrate --phase expand" \\
    ./run-migration.sh manifests/my-api.onboard.conf --phase expand
EOF
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --phase)    PHASE="$2";           shift 2 ;;
      --id)       MIGRATION_ID="$2";    shift 2 ;;
      --image)    MIGRATION_IMAGE="$2"; shift 2 ;;
      --timeout)  JOB_TIMEOUT="$2";     shift 2 ;;
      --dry-run)  DRY_RUN="true";       shift ;;
      --history)  HISTORY_SERVICE="$2"; shift 2 ;;
      --help|-h)  usage ;;
      -*)         die "Unknown option: $1" ;;
      *)
        if [[ -z "$CONF_FILE" ]]; then CONF_FILE="$1"
        else die "Unexpected argument: $1"; fi
        shift ;;
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

  # Load image from build result if available
  local result_file
  result_file="$(dirname "$CONF_FILE")/${SERVICE_NAME}.build.result"
  if [[ -z "$MIGRATION_IMAGE" ]]; then
    if [[ -f "$result_file" ]]; then
      # shellcheck source=/dev/null
      source "$result_file"
      MIGRATION_IMAGE="${IMAGE_REF}"
    else
      MIGRATION_IMAGE="${REGISTRY_ADDRESS:-localhost:5050}/${SERVICE_NAME}:latest"
      warn "No build result — using $MIGRATION_IMAGE"
    fi
  fi
}

gen_migration_id() {
  if [[ -z "$MIGRATION_ID" ]]; then
    MIGRATION_ID="$(date -u +"%Y%m%d-%H%M%S")"
  fi
}

# ── Build the Job manifest for a given phase ──────────────────────────────────
gen_job_yaml() {
  local phase="$1"
  local job_name="${SERVICE_NAME}-migrate-${phase}-${MIGRATION_ID}"

  # Command to run inside the container for each phase.
  # Can be overridden by env vars before calling this script.
  local cmd
  case "$phase" in
    expand)   cmd="${MIGRATION_CMD_EXPAND:-migrate-expand}" ;;
    verify)   cmd="${MIGRATION_CMD_VERIFY:-migrate-verify}" ;;
    contract) cmd="${MIGRATION_CMD_CONTRACT:-migrate-contract}" ;;
    *) die "Unknown phase: $phase" ;;
  esac

  cat <<EOF
# Migration Job — $SERVICE_NAME / $phase / $MIGRATION_ID
# Generated by run-migration.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job_name}
  namespace: ${APPS_NAMESPACE}
  labels:
    app.kubernetes.io/name: ${SERVICE_NAME}
    app.kubernetes.io/part-of: k8s-platform
    platform/migration-id: "${MIGRATION_ID}"
    platform/migration-phase: "${phase}"
  annotations:
    platform/service: "${SERVICE_NAME}"
    platform/phase: "${phase}"
    platform/started-at: "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${SERVICE_NAME}
        platform/migration-id: "${MIGRATION_ID}"
        platform/migration-phase: "${phase}"
    spec:
      restartPolicy: Never
      serviceAccountName: ${SERVICE_NAME}
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: migration
          image: ${MIGRATION_IMAGE}
          imagePullPolicy: Always
          command: ["sh", "-c", "${cmd}"]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          env:
            - name: MIGRATION_PHASE
              value: "${phase}"
            - name: MIGRATION_ID
              value: "${MIGRATION_ID}"
            - name: PORT
              valueFrom:
                configMapKeyRef:
                  name: ${SERVICE_NAME}-config
                  key: PORT
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
EOF
}

# ── Run one phase ─────────────────────────────────────────────────────────────
run_phase() {
  local phase="$1"
  local job_name="${SERVICE_NAME}-migrate-${phase}-${MIGRATION_ID}"

  header "Migration: $SERVICE_NAME / phase=$phase / id=$MIGRATION_ID"

  local job_yaml
  job_yaml=$(gen_job_yaml "$phase")

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "$job_yaml"
    return 0
  fi

  # Apply Job
  echo "$job_yaml" | kubectl apply -f -
  info "Job $job_name created"

  # Stream logs while waiting
  info "Waiting for pod to start..."
  local pod=""
  local retries=30
  while [[ $retries -gt 0 ]]; do
    pod=$(kubectl get pods -n "$APPS_NAMESPACE" \
      -l "platform/migration-id=${MIGRATION_ID},platform/migration-phase=${phase}" \
      --field-selector=status.phase!=Pending \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    [[ -n "$pod" ]] && break
    sleep 2
    retries=$(( retries - 1 ))
  done

  if [[ -z "$pod" ]]; then
    record_result "$phase" "failed" "Pod never started"
    die "Pod for $job_name never started"
  fi

  info "Streaming logs from $pod..."
  kubectl logs -n "$APPS_NAMESPACE" "$pod" -f 2>/dev/null || true

  # Wait for Job to complete
  local status
  if kubectl wait job/"$job_name" \
      -n "$APPS_NAMESPACE" \
      --for=condition=complete \
      --timeout="${JOB_TIMEOUT}s" 2>/dev/null; then
    status="succeeded"
    success "Phase $phase succeeded"
  elif kubectl wait job/"$job_name" \
      -n "$APPS_NAMESPACE" \
      --for=condition=failed \
      --timeout=5s 2>/dev/null; then
    status="failed"
    local logs
    logs=$(kubectl logs -n "$APPS_NAMESPACE" "$pod" --tail=20 2>/dev/null || echo "(no logs)")
    record_result "$phase" "failed" "$logs"
    die "Phase $phase FAILED. Last 20 lines of logs recorded. See: ./run-migration.sh --history $SERVICE_NAME"
  else
    status="timeout"
    record_result "$phase" "timeout" "Job exceeded ${JOB_TIMEOUT}s timeout"
    die "Phase $phase TIMED OUT after ${JOB_TIMEOUT}s"
  fi

  record_result "$phase" "$status" ""
}

# ── Record result to ConfigMap ────────────────────────────────────────────────
# Results stored in cluster so dashboard (Phase 3) can read them without
# needing access to local files.
record_result() {
  local phase="$1"
  local status="$2"
  local notes="$3"
  local cm_name="${SERVICE_NAME}-migration-history"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local entry_key="${MIGRATION_ID}-${phase}"
  local entry_val="${timestamp}|${status}|${notes:0:200}"

  # Upsert ConfigMap entry
  if kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" &>/dev/null; then
    kubectl patch configmap "$cm_name" \
      -n "$APPS_NAMESPACE" \
      --type merge \
      -p "{\"data\":{\"${entry_key}\":\"${entry_val}\"}}" 2>/dev/null \
      || warn "Could not update migration history ConfigMap"
  else
    kubectl create configmap "$cm_name" \
      -n "$APPS_NAMESPACE" \
      --from-literal="${entry_key}=${entry_val}" \
      2>/dev/null \
      || warn "Could not create migration history ConfigMap"
  fi
}

# ── Run all phases in sequence ────────────────────────────────────────────────
run_all() {
  run_phase "expand"
  success "Expand complete."

  if [[ "${NON_INTERACTIVE:-false}" != "true" ]]; then
    echo ""
    read -rp "  Proceed to VERIFY? [Y/n]: " confirm
    [[ "${confirm:-Y}" =~ ^[Yy]$ ]] || { warn "Stopped after expand."; exit 0; }
  fi

  run_phase "verify"
  success "Verify complete."

  if [[ "${NON_INTERACTIVE:-false}" != "true" ]]; then
    echo ""
    warn "CONTRACT will remove old schema. Ensure all pods are running new code."
    read -rp "  Proceed to CONTRACT? [y/N]: " confirm
    [[ "${confirm:-N}" =~ ^[Yy]$ ]] || { warn "Stopped after verify. Run contract when ready."; exit 0; }
  fi

  run_phase "contract"
  success "All three phases complete."
}

# ── Show history ──────────────────────────────────────────────────────────────
show_history() {
  local svc="$1"
  local cm_name="${svc}-migration-history"
  header "Migration history — $svc"
  echo ""

  if ! kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" &>/dev/null; then
    echo "  No migration history found for $svc"
    return
  fi

  # Read all entries and sort by key (which starts with timestamp)
  kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" \
    -o jsonpath='{.data}' 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
rows = []
for key, val in data.items():
    parts = val.split('|', 2)
    ts = parts[0] if len(parts) > 0 else ''
    status = parts[1] if len(parts) > 1 else ''
    notes = parts[2] if len(parts) > 2 else ''
    migration_id, phase = key.rsplit('-', 1) if '-' in key else (key, '')
    rows.append((ts, migration_id, phase, status, notes))
rows.sort()
for ts, mid, phase, status, notes in rows:
    icon = '✓' if status == 'succeeded' else ('✗' if status == 'failed' else '?')
    print(f'  {icon} {ts}  id={mid}  phase={phase:<8}  {status}')
    if notes:
        print(f'      {notes[:120]}')
" 2>/dev/null || kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" -o yaml
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  case "${1:-}" in
    --help|-h) usage ;;
  esac

  parse_args "$@"

  if [[ -n "$HISTORY_SERVICE" ]]; then
    show_history "$HISTORY_SERVICE"
    exit 0
  fi

  [[ -n "$CONF_FILE" ]] || die "Usage: ./run-migration.sh <service.onboard.conf> --phase <phase>"
  [[ -n "$PHASE" ]]     || die "--phase is required (expand | verify | contract | all)"

  header "Kubernetes Platform — Migration Runner"
  load_config
  gen_migration_id

  case "$PHASE" in
    expand|verify|contract) run_phase "$PHASE" ;;
    all)                    run_all ;;
    *) die "Unknown phase: $PHASE (expand | verify | contract | all)" ;;
  esac
}

main "$@"
