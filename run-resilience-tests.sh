#!/usr/bin/env bash
# run-resilience-tests.sh
# Orchestrator: runs all three resilience tests in sequence for a service.
# Results are written as JSON and stored in a ConfigMap for the dashboard.
#
# Tests:
#   1. pod-failure      — kill a pod, verify recovery within timeout
#   2. network-partition — block egress from pods, verify graceful degradation
#   3. resource-exhaustion — apply a CPU/memory stress Job, verify autoscaling/limits
#
# Usage:
#   ./run-resilience-tests.sh <service.onboard.conf>
#   ./run-resilience-tests.sh <service.onboard.conf> --test pod-failure
#   ./run-resilience-tests.sh --results <service-name>

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()    { echo -e "${RED}[FAIL]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

CONF_FILE=""
RUN_TEST=""        # specific test name, or empty = all
RESULTS_SERVICE="" # for --results flag
RECOVERY_TIMEOUT="${RECOVERY_TIMEOUT:-60}"   # seconds to wait for pod recovery
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
RUN_ID="$(date -u +"%Y%m%d-%H%M%S")"
RESULTS_FILE=""    # set after load_config
declare -A TEST_RESULTS=()   # test_name → pass|fail

usage() {
  cat <<EOF
${BOLD}run-resilience-tests.sh${NC} — Run resilience tests for a service

${BOLD}Usage:${NC}
  ./run-resilience-tests.sh <service.onboard.conf>
  ./run-resilience-tests.sh <service.onboard.conf> --test <name>
  ./run-resilience-tests.sh --results <service-name>

${BOLD}Tests:${NC}
  pod-failure          Kill a pod; assert replacement comes up within ${RECOVERY_TIMEOUT}s
  network-partition    Apply a NetworkPolicy blocking egress; check service stays up
  resource-exhaustion  Run a stress Job against the service; verify limits hold

${BOLD}Options:${NC}
  --test      <name>    Run only one test
  --timeout   <secs>    Recovery timeout (default: 60)
  --results   <svc>     Print stored results for a service
EOF
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --test)     RUN_TEST="$2";         shift 2 ;;
      --timeout)  RECOVERY_TIMEOUT="$2"; shift 2 ;;
      --results)  RESULTS_SERVICE="$2";  shift 2 ;;
      --help|-h)  usage ;;
      -*)         die "Unknown option: $1" ;;
      *)
        [[ -z "$CONF_FILE" ]] && CONF_FILE="$1" || die "Unexpected: $1"
        shift ;;
    esac
  done
}

load_config() {
  [[ -f "$CONF_FILE" ]] || die "Config not found: $CONF_FILE"
  # shellcheck source=/dev/null
  source "$CONF_FILE"
  for var in SERVICE_NAME APPS_NAMESPACE PORT; do
    [[ -n "${!var:-}" ]] || die "Config missing: $var"
  done
  APPS_NAMESPACE="${APPS_NAMESPACE}"
  RESULTS_FILE="$(dirname "$CONF_FILE")/${SERVICE_NAME}.resilience-results.json"
}

# ── Helpers ───────────────────────────────────────────────────────────────────

get_a_pod() {
  kubectl get pods -n "$APPS_NAMESPACE" \
    -l "app.kubernetes.io/name=${SERVICE_NAME}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo ""
}

count_ready_pods() {
  kubectl get deployment "$SERVICE_NAME" -n "$APPS_NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0"
}

desired_replicas() {
  kubectl get deployment "$SERVICE_NAME" -n "$APPS_NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1"
}

cleanup_network_policy() {
  kubectl delete networkpolicy "${SERVICE_NAME}-test-block-egress" \
    -n "$APPS_NAMESPACE" --ignore-not-found &>/dev/null || true
}

cleanup_stress_job() {
  kubectl delete job "${SERVICE_NAME}-stress-test" \
    -n "$APPS_NAMESPACE" --ignore-not-found &>/dev/null || true
}

record_test() {
  local name="$1" result="$2" detail="$3"
  TEST_RESULTS["$name"]="$result"
  if [[ "$result" == "pass" ]]; then
    success "[$name] PASS — $detail"
  else
    fail    "[$name] FAIL — $detail"
  fi
}

# ── Test 1: Pod Failure ───────────────────────────────────────────────────────
test_pod_failure() {
  header "Test 1: Pod Failure"
  info "Checking deployment exists..."

  local desired
  desired=$(desired_replicas)
  [[ "$desired" -ge 1 ]] || { record_test "pod-failure" "fail" "No replicas found for $SERVICE_NAME"; return; }

  local victim
  victim=$(get_a_pod)
  if [[ -z "$victim" ]]; then
    record_test "pod-failure" "fail" "No running pods found for $SERVICE_NAME"
    return
  fi

  info "Killing pod: $victim"
  kubectl delete pod "$victim" -n "$APPS_NAMESPACE" --grace-period=0 --force &>/dev/null

  info "Waiting for $desired ready replica(s) within ${RECOVERY_TIMEOUT}s..."
  local elapsed=0
  while [[ $elapsed -lt $RECOVERY_TIMEOUT ]]; do
    local ready
    ready=$(count_ready_pods)
    if [[ "${ready:-0}" -ge "$desired" ]]; then
      record_test "pod-failure" "pass" "Recovered to ${ready}/${desired} ready in ${elapsed}s"
      return
    fi
    sleep 3
    elapsed=$(( elapsed + 3 ))
    echo -n "."
  done
  echo ""

  local final_ready
  final_ready=$(count_ready_pods)
  record_test "pod-failure" "fail" "Only ${final_ready:-0}/${desired} ready after ${RECOVERY_TIMEOUT}s"
}

# ── Test 2: Network Partition ─────────────────────────────────────────────────
test_network_partition() {
  header "Test 2: Network Partition (egress block)"

  # Requires NetworkPolicy support in the cluster (most CNIs support it).
  # Applies a policy blocking all egress from the service pods, then verifies
  # the pods remain Running (not crashing) and the readiness probe keeps passing.
  trap cleanup_network_policy EXIT

  info "Applying egress-blocking NetworkPolicy to $SERVICE_NAME pods"
  cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${SERVICE_NAME}-test-block-egress
  namespace: ${APPS_NAMESPACE}
  labels:
    platform/test: "network-partition"
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${SERVICE_NAME}
  policyTypes:
    - Egress
  egress: []
EOF

  info "Waiting 10s to observe pod behaviour under network partition..."
  sleep 10

  # Check pods are still Running (not CrashLooping)
  local running
  running=$(kubectl get pods -n "$APPS_NAMESPACE" \
    -l "app.kubernetes.io/name=${SERVICE_NAME}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items}' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "0")

  local desired
  desired=$(desired_replicas)

  info "Removing NetworkPolicy"
  cleanup_network_policy
  trap - EXIT

  # Wait for readiness to restore
  sleep 5
  local ready
  ready=$(count_ready_pods)

  if [[ "${running:-0}" -ge 1 ]] && [[ "${ready:-0}" -ge 1 ]]; then
    record_test "network-partition" "pass" "Pods stayed Running (${running}/${desired}) during partition; ${ready} ready after removal"
  else
    record_test "network-partition" "fail" "Pods not healthy during/after partition: running=${running:-0} ready=${ready:-0} desired=${desired}"
  fi
}

# ── Test 3: Resource Exhaustion ───────────────────────────────────────────────
test_resource_exhaustion() {
  header "Test 3: Resource Exhaustion"

  trap cleanup_stress_job EXIT

  info "Launching stress Job targeting $SERVICE_NAME in $APPS_NAMESPACE"
  # Stress Job: hammers the service with requests using a minimal alpine+curl image.
  # Runs for 20s, then we check pod status and resource usage.
  local svc_host="${SERVICE_NAME}.${APPS_NAMESPACE}.svc.cluster.local"

  cat <<EOF | kubectl apply -f - &>/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: ${SERVICE_NAME}-stress-test
  namespace: ${APPS_NAMESPACE}
  labels:
    platform/test: "resource-exhaustion"
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        platform/test: "resource-exhaustion"
    spec:
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
      containers:
        - name: stress
          image: alpine/curl:latest
          command:
            - sh
            - -c
            - |
              echo "Stressing ${svc_host}:${PORT} for 20s..."
              end=\$(( \$(date +%s) + 20 ))
              count=0
              while [ \$(date +%s) -lt \$end ]; do
                curl -sf --max-time 1 "http://${svc_host}:${PORT}${LIVENESS_PATH:-/healthz}" >/dev/null 2>&1 && count=\$(( count + 1 )) || true
              done
              echo "Sent \$count requests"
          resources:
            requests:
              cpu: 50m
              memory: 32Mi
            limits:
              cpu: 200m
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
EOF

  info "Stress running for 20s — monitoring pod status..."
  sleep 20

  # Check pods are still healthy
  local ready
  ready=$(count_ready_pods)
  local desired
  desired=$(desired_replicas)

  # Check no OOMKilled or CrashLoopBackOff
  local bad_pods
  bad_pods=$(kubectl get pods -n "$APPS_NAMESPACE" \
    -l "app.kubernetes.io/name=${SERVICE_NAME}" \
    -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null \
    | tr ' ' '\n' | grep -c "OOMKilled\|CrashLoopBackOff\|Error" 2>/dev/null || echo "0")

  cleanup_stress_job
  trap - EXIT

  if [[ "${ready:-0}" -ge 1 ]] && [[ "${bad_pods:-0}" -eq 0 ]]; then
    record_test "resource-exhaustion" "pass" "${ready}/${desired} pods healthy after stress; no OOMKilled or CrashLoop"
  else
    record_test "resource-exhaustion" "fail" "ready=${ready:-0}/${desired} bad_pods=${bad_pods:-0} after stress"
  fi
}

# ── Persist results ───────────────────────────────────────────────────────────
save_results() {
  local passed=0 failed=0
  local results_json="{"
  results_json+="\"run_id\":\"${RUN_ID}\","
  results_json+="\"service\":\"${SERVICE_NAME}\","
  results_json+="\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\","
  results_json+="\"tests\":{"

  local first=true
  for test_name in "pod-failure" "network-partition" "resource-exhaustion"; do
    local result="${TEST_RESULTS[$test_name]:-skipped}"
    [[ "$first" == "true" ]] || results_json+=","
    results_json+="\"${test_name}\":\"${result}\""
    first=false
    [[ "$result" == "pass" ]] && passed=$(( passed + 1 )) || true
    [[ "$result" == "fail" ]] && failed=$(( failed + 1 )) || true
  done

  results_json+="},\"passed\":${passed},\"failed\":${failed}}"

  # Write to local file
  echo "$results_json" > "$RESULTS_FILE"
  info "Results written → $RESULTS_FILE"

  # Store in cluster ConfigMap for dashboard (Phase 3)
  local cm_name="${SERVICE_NAME}-resilience-results"
  local entry_key="${RUN_ID}"

  if kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" &>/dev/null; then
    kubectl patch configmap "$cm_name" \
      -n "$APPS_NAMESPACE" \
      --type merge \
      -p "{\"data\":{\"${entry_key}\":$(echo "$results_json" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")}}" \
      2>/dev/null || warn "Could not update results ConfigMap"
  else
    kubectl create configmap "$cm_name" \
      -n "$APPS_NAMESPACE" \
      --from-literal="${entry_key}=${results_json}" \
      2>/dev/null || warn "Could not create results ConfigMap"
  fi
}

# ── Print stored results ──────────────────────────────────────────────────────
show_results() {
  local svc="$1"
  local cm_name="${svc}-resilience-results"
  header "Resilience test results — $svc"

  if ! kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" &>/dev/null; then
    echo "  No results found for $svc. Run: ./run-resilience-tests.sh manifests/$svc.onboard.conf"
    return
  fi

  kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" \
    -o jsonpath='{.data}' 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
runs = []
for run_id, val in data.items():
    try:
        r = json.loads(val)
        runs.append((r.get('timestamp',''), run_id, r))
    except Exception:
        runs.append((run_id, run_id, {'tests': {}, 'passed': '?', 'failed': '?'}))
runs.sort(reverse=True)
for ts, run_id, r in runs[:10]:
    p = r.get('passed', '?'); f = r.get('failed', '?')
    print(f'  Run {run_id}  passed={p}  failed={f}')
    for t, res in r.get('tests', {}).items():
        icon = '✓' if res == 'pass' else ('✗' if res == 'fail' else '—')
        print(f'    {icon} {t}: {res}')
    print()
" 2>/dev/null || kubectl get configmap "$cm_name" -n "$APPS_NAMESPACE" -o yaml
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  header "Resilience test run complete — $SERVICE_NAME / $RUN_ID"
  echo ""
  local passed=0 failed=0
  for test_name in "pod-failure" "network-partition" "resource-exhaustion"; do
    local result="${TEST_RESULTS[$test_name]:-skipped}"
    local icon="—"
    [[ "$result" == "pass" ]] && { icon="${GREEN}✓${NC}"; passed=$(( passed + 1 )); }
    [[ "$result" == "fail" ]] && { icon="${RED}✗${NC}"; failed=$(( failed + 1 )); }
    echo -e "  $icon  $test_name: $result"
  done
  echo ""
  echo "  Passed: $passed / Failed: $failed"
  echo "  Results: $RESULTS_FILE"
  echo ""
  echo "  View history: ./run-resilience-tests.sh --results $SERVICE_NAME"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  case "${1:-}" in --help|-h) usage ;; esac

  parse_args "$@"

  if [[ -n "$RESULTS_SERVICE" ]]; then
    show_results "$RESULTS_SERVICE"
    exit 0
  fi

  [[ -n "$CONF_FILE" ]] || die "Usage: ./run-resilience-tests.sh <service.onboard.conf>"

  header "Kubernetes Platform — Resilience Tests"
  load_config

  # Verify service exists before running tests
  kubectl get deployment "$SERVICE_NAME" -n "$APPS_NAMESPACE" &>/dev/null \
    || die "Deployment $SERVICE_NAME not found in $APPS_NAMESPACE. Deploy the service first."

  case "${RUN_TEST:-all}" in
    pod-failure)         test_pod_failure ;;
    network-partition)   test_network_partition ;;
    resource-exhaustion) test_resource_exhaustion ;;
    all)
      test_pod_failure
      test_network_partition
      test_resource_exhaustion
      ;;
    *) die "Unknown test: $RUN_TEST (pod-failure | network-partition | resource-exhaustion)" ;;
  esac

  save_results
  print_summary
}

main "$@"
