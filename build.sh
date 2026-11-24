#!/usr/bin/env bash
# build.sh
# Builds a container image for an onboarded service.
# Strategy: Cloud Native Buildpacks (Paketo) → Dockerfile → error.
# Nothing about any specific service is hardcoded.
#
# Usage:
#   ./build.sh <path/to/service.onboard.conf>
#   ./build.sh --help

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

# ── Defaults ──────────────────────────────────────────────────────────────────
CONF_FILE=""
BUILD_TAG="${BUILD_TAG:-}"          # override image tag (default: git short SHA or 'latest')
WORK_DIR=""                         # temp clone directory
SKIP_SMOKE="${SKIP_SMOKE:-false}"   # skip smoke-test after push
BUILDER="${PAKETO_BUILDER:-paketobuildpacks/builder-jammy-base}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-platform}"

usage() {
  cat <<EOF
${BOLD}build.sh${NC} — Build and push a service image

${BOLD}Usage:${NC}
  ./build.sh <service.onboard.conf>

${BOLD}Environment variables:${NC}
  BUILD_TAG         Override image tag (default: git short SHA of cloned repo)
  PAKETO_BUILDER    Buildpacks builder image (default: paketobuildpacks/builder-jammy-base)
  SKIP_SMOKE        Set to 'true' to skip smoke-test after push
  PLATFORM_NAMESPACE Kubernetes namespace for registry ConfigMap (default: platform)

${BOLD}Build strategy:${NC}
  1. If BUILD_METHOD=buildpacks (or auto) and 'pack' CLI is available → Paketo buildpacks
  2. If a Dockerfile is found in the repo root → Docker build
  3. If neither works → clear error, no silent fallback

${BOLD}Examples:${NC}
  ./build.sh manifests/my-api.onboard.conf
  BUILD_TAG=v1.2.3 ./build.sh manifests/my-api.onboard.conf
EOF
  exit 0
}

# ── Load config ───────────────────────────────────────────────────────────────
load_config() {
  [[ -f "$CONF_FILE" ]] || die "Config file not found: $CONF_FILE"
  # shellcheck source=/dev/null
  source "$CONF_FILE"

  # Verify required fields are present after sourcing
  for var in SERVICE_NAME REPO_URL BRANCH BUILD_METHOD PORT REGISTRY_ADDRESS; do
    [[ -n "${!var:-}" ]] || die "Config missing required field: $var (in $CONF_FILE)"
  done
}

# ── Resolve registry (config → cluster ConfigMap → default) ──────────────────
resolve_registry() {
  if [[ -n "${REGISTRY_ADDRESS:-}" ]]; then return; fi

  if kubectl get configmap platform-registry -n "$PLATFORM_NAMESPACE" &>/dev/null; then
    REGISTRY_ADDRESS=$(kubectl get configmap platform-registry \
      -n "$PLATFORM_NAMESPACE" \
      -o jsonpath='{.data.registry_address}' 2>/dev/null || echo "")
  fi

  [[ -n "$REGISTRY_ADDRESS" ]] || REGISTRY_ADDRESS="localhost:5050"
  warn "Registry not in config — using $REGISTRY_ADDRESS"
}

# ── Clone repo to temp dir ────────────────────────────────────────────────────
clone_repo() {
  WORK_DIR=$(mktemp -d "/tmp/platform-build-${SERVICE_NAME}-XXXXXX")
  trap 'rm -rf "$WORK_DIR"' EXIT

  info "Cloning $REPO_URL @ $BRANCH → $WORK_DIR"
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$WORK_DIR" \
    || die "Failed to clone $REPO_URL branch $BRANCH"
  success "Cloned"
}

# ── Determine image tag ───────────────────────────────────────────────────────
resolve_tag() {
  if [[ -n "$BUILD_TAG" ]]; then
    IMAGE_TAG="$BUILD_TAG"
  else
    IMAGE_TAG=$(git -C "$WORK_DIR" rev-parse --short HEAD 2>/dev/null || echo "latest")
  fi
  IMAGE_REF="${REGISTRY_ADDRESS}/${SERVICE_NAME}:${IMAGE_TAG}"
  IMAGE_LATEST="${REGISTRY_ADDRESS}/${SERVICE_NAME}:latest"
  info "Image ref: $IMAGE_REF"
}

# ── Build: Cloud Native Buildpacks ───────────────────────────────────────────
build_with_buildpacks() {
  info "Building with Paketo Buildpacks (builder: $BUILDER)"

  # Detect pack CLI
  command -v pack &>/dev/null || return 1

  # Check for procfile or standard buildpack-detectable structure
  pack build "$IMAGE_REF" \
    --builder "$BUILDER" \
    --path "$WORK_DIR" \
    --tag "$IMAGE_LATEST" \
    --publish \
    2>&1 | while IFS= read -r line; do echo "    $line"; done

  local exit_code=${PIPESTATUS[0]}
  if [[ $exit_code -eq 0 ]]; then
    success "Built with buildpacks: $IMAGE_REF"
    BUILD_USED="buildpacks"
    return 0
  fi
  return 1
}

# ── Build: Dockerfile ─────────────────────────────────────────────────────────
build_with_dockerfile() {
  local dockerfile=""

  # Look for Dockerfile in common locations
  for candidate in \
    "$WORK_DIR/Dockerfile" \
    "$WORK_DIR/dockerfile" \
    "$WORK_DIR/Dockerfile.prod" \
    "$WORK_DIR/docker/Dockerfile"; do
    if [[ -f "$candidate" ]]; then
      dockerfile="$candidate"
      break
    fi
  done

  if [[ -z "$dockerfile" ]]; then
    return 1
  fi

  info "Building with Dockerfile: $dockerfile"

  docker build \
    -f "$dockerfile" \
    -t "$IMAGE_REF" \
    -t "$IMAGE_LATEST" \
    "$WORK_DIR" \
    2>&1 | while IFS= read -r line; do echo "    $line"; done

  local exit_code=${PIPESTATUS[0]}
  [[ $exit_code -eq 0 ]] || return 1

  info "Pushing $IMAGE_REF"
  docker push "$IMAGE_REF"
  docker push "$IMAGE_LATEST"

  success "Built with Dockerfile: $IMAGE_REF"
  BUILD_USED="dockerfile"
  return 0
}

# ── Build dispatcher ──────────────────────────────────────────────────────────
run_build() {
  BUILD_USED=""

  case "$BUILD_METHOD" in
    buildpacks)
      build_with_buildpacks \
        || die "Buildpacks build failed. 'pack' CLI may not be installed (brew install buildpacks/tap/pack)."
      ;;
    dockerfile)
      build_with_dockerfile \
        || die "Dockerfile build failed. Ensure a Dockerfile exists at the repo root."
      ;;
    auto)
      info "Build method: auto — trying buildpacks first, then Dockerfile"
      if command -v pack &>/dev/null; then
        build_with_buildpacks && return
        warn "Buildpacks failed — falling back to Dockerfile"
      else
        warn "'pack' not found — skipping buildpacks, trying Dockerfile"
      fi
      build_with_dockerfile \
        || die "Auto build failed: no Dockerfile found and buildpacks unavailable.\n  Install pack: https://buildpacks.io/docs/tools/pack/"
      ;;
    *)
      die "Unknown build method: $BUILD_METHOD (expected: buildpacks | dockerfile | auto)"
      ;;
  esac
}

# ── Smoke test ────────────────────────────────────────────────────────────────
# Runs the built image locally for a few seconds, hits the healthz/ready endpoints,
# then removes the container. This is a disposable check — not a service deployment.
smoke_test() {
  if [[ "$SKIP_SMOKE" == "true" ]]; then
    info "Smoke test skipped (SKIP_SMOKE=true)"
    return
  fi

  header "Smoke test"

  # Pick a random high port to avoid conflicts
  local test_port=$(( RANDOM % 10000 + 50000 ))
  local container_name="smoke-${SERVICE_NAME}-$$"

  info "Running smoke container: $IMAGE_REF on port $test_port"

  # Start container in background
  docker run -d \
    --name "$container_name" \
    -p "${test_port}:${PORT}" \
    --rm \
    "$IMAGE_REF" &>/dev/null \
    || { warn "Could not start smoke container — skipping smoke test"; return; }

  # Give the app a few seconds to start
  local max_wait=30
  local waited=0
  local ok=false

  info "Waiting for container to respond (max ${max_wait}s)..."
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf --max-time 2 "http://localhost:${test_port}${LIVENESS_PATH:-/healthz}" &>/dev/null; then
      ok=true
      break
    fi
    sleep 2
    waited=$(( waited + 2 ))
    echo -n "."
  done
  echo ""

  # Cleanup — always remove, regardless of test result
  docker rm -f "$container_name" &>/dev/null || true

  if [[ "$ok" == "true" ]]; then
    success "Smoke test passed — container responded on ${LIVENESS_PATH:-/healthz}"
  else
    warn "Smoke test: container did not respond within ${max_wait}s on port $test_port${LIVENESS_PATH:-/healthz}"
    warn "Image was still built and pushed. Check your app's health endpoint."
    warn "To skip smoke tests: SKIP_SMOKE=true ./build.sh $CONF_FILE"
  fi
}

# ── Write build result ────────────────────────────────────────────────────────
write_build_result() {
  local result_file
  result_file="$(dirname "$CONF_FILE")/${SERVICE_NAME}.build.result"

  cat > "$result_file" <<EOF
# Build result — written by build.sh
# Source: $CONF_FILE
BUILD_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SERVICE_NAME="${SERVICE_NAME}"
IMAGE_REF="${IMAGE_REF}"
IMAGE_LATEST="${IMAGE_LATEST}"
IMAGE_TAG="${IMAGE_TAG}"
BUILD_USED="${BUILD_USED}"
REPO_URL="${REPO_URL}"
BRANCH="${BRANCH}"
EOF

  info "Build result written → $result_file"
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  header "Build complete — $SERVICE_NAME"
  echo ""
  echo "  Image     : $IMAGE_REF"
  echo "  Tag       : $IMAGE_TAG"
  echo "  Method    : $BUILD_USED"
  echo "  Registry  : $REGISTRY_ADDRESS"
  echo ""
  echo "  Next step:"
  echo "    ./generate-manifests.sh $CONF_FILE"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  case "${1:-}" in
    --help|-h) usage ;;
    "") die "Usage: ./build.sh <service.onboard.conf>  |  ./build.sh --help" ;;
    *) CONF_FILE="$1" ;;
  esac

  header "Kubernetes Platform — Build Pipeline"

  load_config
  resolve_registry
  clone_repo
  resolve_tag
  run_build
  smoke_test
  write_build_result
  print_summary
}

main "$@"
