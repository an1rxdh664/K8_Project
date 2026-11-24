#!/usr/bin/env bash
# measure.sh — repeatable benchmarks for an onboarded service.
#
# Every number comes from a real kubectl/curl observation on YOUR cluster and is
# appended to a CSV. Nothing is estimated. Failed runs are recorded as they are.
#
# Usage:
#   ./measure.sh <service.onboard.conf> [options]
#
# Options:
#   --tests   LIST     comma list of: footprint,recovery,partition,load,coldstart,migration
#                      (default: footprint,recovery,partition)
#   --runs N           repetitions for recovery/partition/coldstart/migration (default 5)
#   --load-runs N      repetitions for the autoscaling load test (default 3; each takes minutes)
#   --out DIR          results root (default: ./results)
#   --workers N        parallel request loops for the load test (default 20)
#   --duration S       load duration in seconds (default 120)
#   --scaledown-wait S max seconds to wait for scale-down after load (default 900)
#   --path P           HTTP path the load generator requests (default: LIVENESS_PATH from conf)
#   --timeout S        per-event timeout (default 120)
#
# Prerequisites: kubectl (pointing at your k3d/kind cluster), python3, the service
# deployed in its namespace, metrics-server for `kubectl top` (k3s ships it).
#   load      needs a ScaledObject:   ./configure-autoscaling.sh <conf> --trigger cpu --max 5
#   coldstart needs NO ScaledObject (it scales the Deployment 0 -> N by hand)
#   migration needs the image to implement migrate-expand/verify/contract and the
#             commands must be safe to run repeatedly (contract is destructive).

set -uo pipefail   # no -e: one failed measurement must not abort the rest

CONF=""
TESTS="footprint,recovery,partition"
RUNS=5
LOAD_RUNS=3
OUT_ROOT="./results"
WORKERS=20
DURATION=120
SCALEDOWN_WAIT=900
REQ_PATH=""
TIMEOUT=120

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tests)          TESTS="$2"; shift 2 ;;
    --runs)           RUNS="$2"; shift 2 ;;
    --load-runs)      LOAD_RUNS="$2"; shift 2 ;;
    --out)            OUT_ROOT="$2"; shift 2 ;;
    --workers)        WORKERS="$2"; shift 2 ;;
    --duration)       DURATION="$2"; shift 2 ;;
    --scaledown-wait) SCALEDOWN_WAIT="$2"; shift 2 ;;
    --path)           REQ_PATH="$2"; shift 2 ;;
    --timeout)        TIMEOUT="$2"; shift 2 ;;
    -h|--help)        usage ;;
    -*)               echo "Unknown option: $1" >&2; exit 1 ;;
    *)                CONF="$1"; shift ;;
  esac
done

[[ -n "$CONF" && -f "$CONF" ]] || { echo "Usage: ./measure.sh <service.onboard.conf> [options]" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

# shellcheck source=/dev/null
source "$CONF"
: "${SERVICE_NAME:?config missing SERVICE_NAME}"
NS="${APPS_NAMESPACE:-apps}"
SELECTOR="app.kubernetes.io/name=${SERVICE_NAME}"
REQ_PATH="${REQ_PATH:-${LIVENESS_PATH:-/healthz}}"
SVC_PORT=80   # generate-manifests.sh exposes the Service on port 80 -> targetPort http
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/run-migration.sh" ]] && ROOT="$SCRIPT_DIR" || ROOT="$(cd "$(dirname "$CONF")/.." && pwd)"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${OUT_ROOT}/${SERVICE_NAME}-${STAMP}"
mkdir -p "$OUT"

log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/measure.log"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
has_test() { [[ ",$TESTS," == *",$1,"* ]]; }
csv_init() { local f="$1"; shift; echo "$*" > "$f"; }
strip_ansi() { sed $'s/\033\\[[0-9;]*m//g'; }

spec_replicas()  { kubectl get deploy "$SERVICE_NAME" -n "$NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0; }
ready_replicas() { local r; r=$(kubectl get deploy "$SERVICE_NAME" -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null); echo "${r:-0}"; }
has_scaledobject() { kubectl get scaledobject "$SERVICE_NAME" -n "$NS" >/dev/null 2>&1; }

# Number of Ready pods that are not the given (victim) pod and not terminating.
ready_other_pods() {
  local victim="$1"
  kubectl get pods -n "$NS" -l "$SELECTOR" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.deletionTimestamp}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
    | awk -v v="$victim" '$1!=v && NF==2 && $2=="True"{c++} END{print c+0}'
}

wait_steady() {   # wait until ready == spec (>=1)
  local deadline=$(( $(date +%s) + TIMEOUT ))
  while [[ $(date +%s) -lt $deadline ]]; do
    local s r; s=$(spec_replicas); r=$(ready_replicas)
    [[ "${s:-0}" -ge 1 && "${r:-0}" -ge "${s:-0}" ]] && return 0
    sleep 1
  done
  return 1
}

# ── In-cluster traffic generator ─────────────────────────────────────────────
# Runs inside the cluster so requests go through the Service (not a pod-bound
# port-forward) and keep flowing when a pod is killed. Log line: "<epoch_s> <http_code> <seconds>"
loadgen_start() {   # name workers sleep_between_requests
  local name="$1" workers="$2" slp="$3"
  local url="http://${SERVICE_NAME}.${NS}.svc.cluster.local:${SVC_PORT}${REQ_PATH}"
  kubectl delete pod "$name" -n "$NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
  kubectl run "$name" -n "$NS" --image=alpine/curl:latest --restart=Never \
    --labels=platform/test=measure --command -- sh -c \
    "for w in \$(seq 1 $workers); do ( while true; do r=\$(curl -s -o /dev/null -m 2 -w '%{http_code} %{time_total}' '$url'); echo \"\$(date +%s) \$r\"; sleep $slp; done ) & done; wait" \
    >/dev/null 2>&1 || return 1
  kubectl wait --for=condition=Ready "pod/$name" -n "$NS" --timeout=90s >/dev/null 2>&1 || return 1
}

loadgen_stop() {    # name outfile
  kubectl logs "$1" -n "$NS" > "$2" 2>/dev/null
  kubectl delete pod "$1" -n "$NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
}

# "total failed" requests with epoch-second timestamp in [t0, t1]; a request fails if code != 200
count_window() {    # logfile t0 t1
  awk -v a="$2" -v b="$3" '$1>=a && $1<=b {n++; if($2!="200") f++} END{print n+0, f+0}' "$1"
}

latency_ms() {      # logfile -> "p50 p95" over successful requests
  awk '$2=="200"{print $3*1000}' "$1" | sort -n | awk '{a[NR]=$1} END{
    if(NR==0){print "NA NA"; exit}
    i=int(NR*0.5)+1; j=int(NR*0.95)+1; if(i>NR)i=NR; if(j>NR)j=NR;
    printf "%.1f %.1f\n", a[i], a[j]}'
}

# ── Environment record ───────────────────────────────────────────────────────
record_env() {
  {
    echo "date_utc: $(date -u +%FT%TZ)"
    echo "host: $(uname -a)"
    echo "cpu_cores: $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo unknown)"
    if command -v free >/dev/null; then echo "memory_mb: $(free -m | awk '/Mem:/{print $2}')";
    else echo "memory_bytes: $(sysctl -n hw.memsize 2>/dev/null || echo unknown)"; fi
    echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo n/a)"
    echo "k3d: $(k3d version 2>/dev/null | head -1 || echo n/a)"
    echo "kind: $(kind version 2>/dev/null || echo n/a)"
    echo "kubectl_client: $(kubectl version --client 2>/dev/null | head -1)"
    echo "kubernetes_server: $(kubectl version 2>/dev/null | grep -i server | head -1)"
    echo "nodes:"; kubectl get nodes -o wide 2>/dev/null
    echo "service: $SERVICE_NAME  namespace: $NS  replicas_spec: $(spec_replicas)"
    echo "resources:"; kubectl get deploy "$SERVICE_NAME" -n "$NS" -o jsonpath='{.spec.template.spec.containers[0].resources}' 2>/dev/null; echo
    echo "scaledobject:"; kubectl get scaledobject "$SERVICE_NAME" -n "$NS" -o yaml 2>/dev/null | sed -n '/spec:/,$p'
    echo "settings: runs=$RUNS load_runs=$LOAD_RUNS workers=$WORKERS duration=${DURATION}s path=$REQ_PATH"
  } > "$OUT/environment.txt" 2>&1
}

# ── 1. Footprint ─────────────────────────────────────────────────────────────
t_footprint() {
  log "FOOTPRINT: 3 samples of kubectl top (10 s apart)"
  csv_init "$OUT/footprint.csv" sample,namespace,pod,cpu_m,mem_mi
  csv_init "$OUT/nodes.csv" sample,node,cpu_m,cpu_pct,mem_mi,mem_pct
  local i
  for i in 1 2 3; do
    kubectl top pods -A --no-headers 2>/dev/null | awk -v s="$i" '
      function mi(x){ if(x~/Gi$/){sub(/Gi$/,"",x);return x*1024} if(x~/Ki$/){sub(/Ki$/,"",x);return x/1024} sub(/Mi$/,"",x);return x }
      { c=$3; sub(/m$/,"",c); print s","$1","$2","c","mi($4) }' >> "$OUT/footprint.csv"
    kubectl top nodes --no-headers 2>/dev/null | awk -v s="$i" '
      function mi(x){ if(x~/Gi$/){sub(/Gi$/,"",x);return x*1024} sub(/Mi$/,"",x);return x }
      { c=$2; sub(/m$/,"",c); p=$3; sub(/%$/,"",p); q=$5; sub(/%$/,"",q); print s","$1","c","p","mi($4)","q }' >> "$OUT/nodes.csv"
    [[ $i -lt 3 ]] && sleep 10
  done
  [[ $(wc -l < "$OUT/footprint.csv") -gt 1 ]] || log "WARNING: kubectl top returned nothing (is metrics-server running?)"
}

# ── 2. Pod-failure recovery under background traffic ─────────────────────────
t_recovery() {
  log "RECOVERY: $RUNS runs (kill a pod, time until a replacement is Ready, count failed requests)"
  csv_init "$OUT/recovery.csv" run,replicas,recovery_ms,window_requests,window_failed,total_requests,total_failed
  local i
  for ((i=1; i<=RUNS; i++)); do
    wait_steady || { log "run $i: service not steady, skipping"; continue; }
    local desired victim lg="measure-lg-rec"
    desired=$(spec_replicas)
    victim=$(kubectl get pods -n "$NS" -l "$SELECTOR" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    [[ -n "$victim" ]] || { log "run $i: no running pod"; continue; }
    loadgen_start "$lg" 2 0.2 || { log "run $i: could not start load generator"; continue; }
    sleep 5
    local t0s t0 t1 t1s
    t0s=$(date +%s); t0=$(now_ms)
    kubectl delete pod "$victim" -n "$NS" --grace-period=0 --force >/dev/null 2>&1
    local deadline=$(( $(date +%s) + TIMEOUT )) ok=0
    while [[ $(date +%s) -lt $deadline ]]; do
      [[ "$(ready_other_pods "$victim")" -ge "$desired" ]] && { ok=1; break; }
      sleep 0.5
    done
    t1=$(now_ms); t1s=$(date +%s)
    sleep 5
    loadgen_stop "$lg" "$OUT/loadgen-recovery-$i.log"
    read -r wt wf <<< "$(count_window "$OUT/loadgen-recovery-$i.log" "$t0s" "$((t1s+1))")"
    read -r tt tf <<< "$(count_window "$OUT/loadgen-recovery-$i.log" 0 99999999999)"
    local rec=$(( t1 - t0 )); [[ $ok -eq 1 ]] || rec="TIMEOUT"
    echo "$i,$desired,$rec,$wt,$wf,$tt,$tf" >> "$OUT/recovery.csv"
    log "run $i: recovery=${rec}ms window_failed=$wf/$wt"
  done
}

# ── 3. Network partition (uses the repo's own test) ──────────────────────────
t_partition() {
  log "PARTITION: $RUNS runs of run-resilience-tests.sh --test network-partition"
  csv_init "$OUT/partition.csv" run,result,detail
  local i out line res detail
  for ((i=1; i<=RUNS; i++)); do
    out=$(bash "$ROOT/run-resilience-tests.sh" "$CONF" --test network-partition 2>&1 | strip_ansi)
    echo "$out" > "$OUT/partition-$i.log"
    line=$(echo "$out" | grep -E '\[network-partition\] (PASS|FAIL)' | head -1)
    res=$(echo "$line" | grep -oE 'PASS|FAIL' | head -1); res="${res:-ERROR}"
    detail=$(echo "$line" | sed 's/^.*— //' | tr ',' ';')
    echo "$i,$res,$detail" >> "$OUT/partition.csv"
    log "run $i: $res"
  done
}

# ── 4. Autoscaling under load ────────────────────────────────────────────────
t_load() {
  if ! has_scaledobject; then
    log "LOAD: skipped — no ScaledObject. Run: ./configure-autoscaling.sh $CONF --trigger cpu --max 5"
    return
  fi
  log "LOAD: $LOAD_RUNS runs, $WORKERS workers, ${DURATION}s, scale-down wait <= ${SCALEDOWN_WAIT}s"
  csv_init "$OUT/load.csv" run,replicas_before,peak_desired,peak_ready,first_scale_decision_s,first_new_ready_s,requests,failed,p50_ms,p95_ms,scaledown_s
  local i
  for ((i=1; i<=LOAD_RUNS; i++)); do
    wait_steady || log "run $i: starting from non-steady state"
    local before lg="measure-lg-load" t_start peak_d=0 peak_r=0 dec="NA" newr="NA"
    before=$(ready_replicas)
    echo "elapsed_s,desired,ready" > "$OUT/load-timeline-$i.csv"
    loadgen_start "$lg" "$WORKERS" 0 || { log "run $i: could not start load generator"; continue; }
    t_start=$(date +%s)
    while :; do
      local el=$(( $(date +%s) - t_start ))
      [[ $el -ge $DURATION ]] && break
      local line d r
      line=$(kubectl get deploy "$SERVICE_NAME" -n "$NS" -o jsonpath='{.spec.replicas} {.status.readyReplicas}' 2>/dev/null)
      d=${line%% *}; r=${line##* }; d=${d:-0}; r=${r:-0}
      echo "$el,$d,$r" >> "$OUT/load-timeline-$i.csv"
      [[ $d -gt $peak_d ]] && peak_d=$d
      [[ $r -gt $peak_r ]] && peak_r=$r
      [[ "$dec"  == "NA" && $d -gt $before ]] && dec=$el
      [[ "$newr" == "NA" && $r -gt $before ]] && newr=$el
      sleep 1
    done
    loadgen_stop "$lg" "$OUT/loadgen-load-$i.log"
    read -r tt tf <<< "$(count_window "$OUT/loadgen-load-$i.log" 0 99999999999)"
    read -r p50 p95 <<< "$(latency_ms "$OUT/loadgen-load-$i.log")"
    # scale-down
    local sd="TIMEOUT" s0; s0=$(date +%s)
    while [[ $(( $(date +%s) - s0 )) -lt $SCALEDOWN_WAIT ]]; do
      [[ "$(spec_replicas)" -le "$before" && "$(ready_replicas)" -le "$before" ]] && { sd=$(( $(date +%s) - s0 )); break; }
      sleep 5
    done
    echo "$i,$before,$peak_d,$peak_r,$dec,$newr,$tt,$tf,$p50,$p95,$sd" >> "$OUT/load.csv"
    log "run $i: before=$before peak_ready=$peak_r first_new_ready=${newr}s failed=$tf/$tt p95=${p95}ms scaledown=${sd}s"
  done
}

# ── 5. Cold start (scale 0 -> N, time until Ready) ───────────────────────────
t_coldstart() {
  if has_scaledobject; then
    log "COLDSTART: skipped — a ScaledObject exists and would override manual scaling. Delete it first: kubectl delete scaledobject $SERVICE_NAME -n $NS"
    return
  fi
  log "COLDSTART: $RUNS runs (scale to 0, then back; time until all replicas Ready)"
  csv_init "$OUT/coldstart.csv" run,replicas,ready_ms
  local orig; orig=$(spec_replicas); [[ "$orig" -ge 1 ]] || orig=1
  local i
  for ((i=1; i<=RUNS; i++)); do
    kubectl scale deploy "$SERVICE_NAME" -n "$NS" --replicas=0 >/dev/null 2>&1
    local d=$(( $(date +%s) + TIMEOUT ))
    while [[ $(date +%s) -lt $d ]]; do
      [[ -z "$(kubectl get pods -n "$NS" -l "$SELECTOR" -o name 2>/dev/null)" ]] && break
      sleep 1
    done
    local t0 t1; t0=$(now_ms)
    kubectl scale deploy "$SERVICE_NAME" -n "$NS" --replicas="$orig" >/dev/null 2>&1
    local ok=0 d2=$(( $(date +%s) + TIMEOUT ))
    while [[ $(date +%s) -lt $d2 ]]; do
      [[ "$(ready_replicas)" -ge "$orig" ]] && { ok=1; break; }
      sleep 0.5
    done
    t1=$(now_ms)
    local v=$(( t1 - t0 )); [[ $ok -eq 1 ]] || v="TIMEOUT"
    echo "$i,$orig,$v" >> "$OUT/coldstart.csv"
    log "run $i: ready after ${v}ms"
  done
}

# ── 6. Migration under traffic ───────────────────────────────────────────────
t_migration() {
  log "MIGRATION: $RUNS runs (expand -> verify -> contract while traffic flows)."
  log "          The migrate-* commands must be idempotent or you must reset the schema between runs."
  csv_init "$OUT/migration.csv" run,expand_ms,verify_ms,contract_ms,expand_status,verify_status,contract_status,total_ms,window_requests,window_failed,baseline_requests,baseline_failed
  local i
  for ((i=1; i<=RUNS; i++)); do
    wait_steady || { log "run $i: service not steady, skipping"; continue; }
    local lg="measure-lg-mig" mid="m$(date +%s)-$i"
    loadgen_start "$lg" 2 0.2 || { log "run $i: could not start load generator"; continue; }
    sleep 10
    local tb0 tw0 tw1 total0 total1
    tb0=$(( $(date +%s) - 8 )); tw0=$(date +%s); total0=$(now_ms)
    local dur=() st=() p
    for p in expand verify contract; do
      local a b; a=$(now_ms)
      NON_INTERACTIVE=true bash "$ROOT/run-migration.sh" "$CONF" --phase "$p" --id "$mid" > "$OUT/migration-$i-$p.log" 2>&1
      local rc=$?; b=$(now_ms)
      dur+=( $(( b - a )) ); [[ $rc -eq 0 ]] && st+=(ok) || st+=(FAILED)
      [[ $rc -ne 0 ]] && break
    done
    total1=$(now_ms); tw1=$(date +%s)
    sleep 10
    loadgen_stop "$lg" "$OUT/loadgen-migration-$i.log"
    read -r wt wf <<< "$(count_window "$OUT/loadgen-migration-$i.log" "$tw0" "$((tw1+1))")"
    read -r bt bf <<< "$(count_window "$OUT/loadgen-migration-$i.log" "$tb0" "$((tw0-1))")"
    echo "$i,${dur[0]:-NA},${dur[1]:-NA},${dur[2]:-NA},${st[0]:-skipped},${st[1]:-skipped},${st[2]:-skipped},$((total1-total0)),$wt,$wf,$bt,$bf" >> "$OUT/migration.csv"
    log "run $i: phases=${st[*]} window_failed=$wf/$wt baseline_failed=$bf/$bt"
  done
}

# ── Main ─────────────────────────────────────────────────────────────────────
log "service=$SERVICE_NAME ns=$NS tests=$TESTS  results -> $OUT"
kubectl get deploy "$SERVICE_NAME" -n "$NS" >/dev/null 2>&1 || { log "Deployment $SERVICE_NAME not found in $NS"; exit 1; }
record_env

has_test footprint && t_footprint
has_test recovery  && t_recovery
has_test partition && t_partition
has_test load      && t_load
has_test coldstart && t_coldstart
has_test migration && t_migration

if [[ -f "$SCRIPT_DIR/summarize.py" ]]; then
  python3 "$SCRIPT_DIR/summarize.py" "$OUT" | tee "$OUT/summary.md"
fi
log "done. Raw data: $OUT"