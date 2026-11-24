#!/usr/bin/env bash
# setup-cluster.sh
# Creates a local Kubernetes cluster (k3d preferred, kind fallback)
# with namespaces, RBAC, and a local registry.
# Nothing about any specific service is hardcoded here.

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-k8s-platform}"
REGISTRY_NAME="${REGISTRY_NAME:-platform-registry}"
REGISTRY_PORT="${REGISTRY_PORT:-5050}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-platform}"
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
OBS_NAMESPACE="${OBS_NAMESPACE:-observability}"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Prerequisite check ────────────────────────────────────────────────────────
check_prereqs() {
  local missing=()
  for cmd in kubectl docker; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done

  if command -v k3d &>/dev/null; then
    DRIVER="k3d"
  elif command -v kind &>/dev/null; then
    DRIVER="kind"
  else
    missing+=("k3d or kind")
  fi

  [[ ${#missing[@]} -eq 0 ]] || die "Missing prerequisites: ${missing[*]}"
  info "Using cluster driver: $DRIVER"
}

# ── Registry ──────────────────────────────────────────────────────────────────
create_registry_k3d() {
  if k3d registry list 2>/dev/null | grep -q "$REGISTRY_NAME"; then
    info "Registry $REGISTRY_NAME already exists — skipping"
  else
    info "Creating k3d registry $REGISTRY_NAME on port $REGISTRY_PORT"
    k3d registry create "$REGISTRY_NAME" --port "$REGISTRY_PORT"
  fi
}

create_registry_kind() {
  # kind uses a Docker container as a registry
  if docker ps --format '{{.Names}}' | grep -q "^kind-registry$"; then
    info "kind registry already running — skipping"
  else
    info "Starting kind registry on port $REGISTRY_PORT"
    docker run -d --restart=always \
      -p "127.0.0.1:${REGISTRY_PORT}:5000" \
      --name kind-registry \
      registry:2
  fi
}

# ── Cluster ───────────────────────────────────────────────────────────────────
create_cluster_k3d() {
  if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER_NAME}"; then
    info "k3d cluster $CLUSTER_NAME already exists — skipping"
    return
  fi
  info "Creating k3d cluster $CLUSTER_NAME"
  k3d cluster create "$CLUSTER_NAME" \
    --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}" \
    --agents 1 \
    --k3s-arg "--disable=traefik@server:0" \
    --wait
}

create_cluster_kind() {
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    info "kind cluster $CLUSTER_NAME already exists — skipping"
    return
  fi

  info "Creating kind cluster $CLUSTER_NAME"
  cat <<EOF | kind create cluster --name "$CLUSTER_NAME" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${REGISTRY_PORT}"]
      endpoint = ["http://kind-registry:${REGISTRY_PORT}"]
nodes:
  - role: control-plane
  - role: worker
EOF

  # Connect registry to kind network
  if ! docker network inspect kind 2>/dev/null | grep -q "kind-registry"; then
    docker network connect kind kind-registry 2>/dev/null || true
  fi

  # Patch nodes to find registry
  REGISTRY_DIR="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  for node in $(kind get nodes --name "$CLUSTER_NAME"); do
    docker exec "$node" mkdir -p "$REGISTRY_DIR"
    docker exec "$node" bash -c "cat > ${REGISTRY_DIR}/hosts.toml <<'TOML'
[host.\"http://kind-registry:${REGISTRY_PORT}\"]
TOML"
  done
}

# ── Namespaces ────────────────────────────────────────────────────────────────
create_namespaces() {
  for ns in "$PLATFORM_NAMESPACE" "$APPS_NAMESPACE" "$OBS_NAMESPACE"; do
    kubectl get namespace "$ns" &>/dev/null \
      && info "Namespace $ns already exists — skipping" \
      || { info "Creating namespace $ns"; kubectl create namespace "$ns"; }
  done
}

# ── RBAC ──────────────────────────────────────────────────────────────────────
apply_rbac() {
  info "Applying platform RBAC"
  kubectl apply -f rbac.yaml
}

# ── Registry ConfigMap (lets pods know where to push/pull) ────────────────────
apply_registry_config() {
  info "Applying registry ConfigMap"
  kubectl apply -f registry-config.yaml
}

# ── kubeconfig context ────────────────────────────────────────────────────────
set_context() {
  local ctx
  if [[ "$DRIVER" == "k3d" ]]; then
    ctx="k3d-${CLUSTER_NAME}"
  else
    ctx="kind-${CLUSTER_NAME}"
  fi
  kubectl config use-context "$ctx" && success "kubectl context → $ctx"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  info "====== Kubernetes Platform — Cluster Setup ======"
  check_prereqs

  if [[ "$DRIVER" == "k3d" ]]; then
    create_registry_k3d
    create_cluster_k3d
  else
    create_registry_kind
    create_cluster_kind
  fi

  set_context
  create_namespaces
  apply_rbac
  apply_registry_config

  success "====== Cluster ready ======"
  echo ""
  echo "  Cluster  : $CLUSTER_NAME"
  echo "  Registry : localhost:$REGISTRY_PORT"
  echo "  Namespaces: $PLATFORM_NAMESPACE | $APPS_NAMESPACE | $OBS_NAMESPACE"
  echo ""
  echo "Next step: run ./onboard.sh --help"
}

main "$@"
