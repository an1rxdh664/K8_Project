#!/usr/bin/env bash
# onboard.sh
# Generic service onboarding CLI for the Kubernetes platform.
# NOTHING about any specific service is hardcoded — every value comes
# from CLI arguments or interactive prompts.
#
# Usage:
#   ./onboard.sh [OPTIONS]
#   ./onboard.sh --help
#
# All options can also be set as environment variables (shown in --help).

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
REPO_URL=""
BRANCH="main"
SERVICE_NAME=""
BUILD_METHOD=""          # buildpacks | dockerfile | auto
DB_MODE=""               # isolated | shared | none
PORT=""
ENV_VARS=()              # KEY=value pairs (non-secret)
SECRET_NAMES=()          # secret key names (values generated/prompted, never stored)
REPLICAS="1"
CPU_REQUEST="100m"
CPU_LIMIT="500m"
MEM_REQUEST="128Mi"
MEM_LIMIT="512Mi"
LIVENESS_PATH="/healthz"
READINESS_PATH="/ready"
HEALTH_INITIAL_DELAY="10"
REGISTRY_ADDRESS=""
OUTPUT_DIR="./manifests"
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-platform}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

# ── Help ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
${BOLD}Kubernetes Platform — Service Onboarding${NC}

${BOLD}Usage:${NC}
  ./onboard.sh [OPTIONS]

${BOLD}Options:${NC}
  -r, --repo          <url>        Git repository URL (env: REPO_URL)
  -b, --branch        <name>       Branch to build (default: main, env: BRANCH)
  -n, --name          <name>       Service name — slug, lowercase, no spaces (env: SERVICE_NAME)
  -m, --build-method  <method>     Build method: buildpacks | dockerfile | auto (env: BUILD_METHOD)
  -d, --db-mode       <mode>       Database mode: isolated | shared | none (env: DB_MODE)
  -p, --port          <port>       Container port the service listens on (env: SERVICE_PORT)
  -e, --env           KEY=VALUE    Non-secret env var (repeatable)
  -s, --secret        KEY_NAME     Secret key name — value will be prompted or generated (repeatable)
  -R, --replicas      <n>          Initial replica count (default: 1)
      --cpu-request   <value>      CPU request (default: 100m)
      --cpu-limit     <value>      CPU limit (default: 500m)
      --mem-request   <value>      Memory request (default: 128Mi)
      --mem-limit     <value>      Memory limit (default: 512Mi)
      --liveness      <path>       Liveness probe HTTP path (default: /healthz)
      --readiness     <path>       Readiness probe HTTP path (default: /ready)
      --health-delay  <seconds>    Initial delay for health probes (default: 10)
      --registry      <addr>       Registry address (default: read from cluster ConfigMap)
      --output-dir    <dir>        Where to write generated manifests (default: ./manifests)
      --non-interactive            Skip all prompts; fail if required args are missing
  -h, --help                       Show this help

${BOLD}Examples:${NC}
  # Fully specified (CI/CD):
  ./onboard.sh \\
    --repo https://github.com/acme/api \\
    --branch main \\
    --name my-api \\
    --build-method buildpacks \\
    --db-mode isolated \\
    --port 8080 \\
    --env LOG_LEVEL=info \\
    --secret DB_PASSWORD \\
    --non-interactive

  # Interactive (developer workstation):
  ./onboard.sh

${BOLD}Environment variables:${NC}
  REPO_URL, BRANCH, SERVICE_NAME, BUILD_METHOD, DB_MODE, SERVICE_PORT,
  APPS_NAMESPACE, PLATFORM_NAMESPACE, NON_INTERACTIVE
EOF
  exit 0
}

# ── Argument parsing ──────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)            usage ;;
      -r|--repo)            REPO_URL="$2";       shift 2 ;;
      -b|--branch)          BRANCH="$2";         shift 2 ;;
      -n|--name)            SERVICE_NAME="$2";   shift 2 ;;
      -m|--build-method)    BUILD_METHOD="$2";   shift 2 ;;
      -d|--db-mode)         DB_MODE="$2";        shift 2 ;;
      -p|--port)            PORT="$2";           shift 2 ;;
      -e|--env)             ENV_VARS+=("$2");    shift 2 ;;
      -s|--secret)          SECRET_NAMES+=("$2");shift 2 ;;
      -R|--replicas)        REPLICAS="$2";       shift 2 ;;
      --cpu-request)        CPU_REQUEST="$2";    shift 2 ;;
      --cpu-limit)          CPU_LIMIT="$2";      shift 2 ;;
      --mem-request)        MEM_REQUEST="$2";    shift 2 ;;
      --mem-limit)          MEM_LIMIT="$2";      shift 2 ;;
      --liveness)           LIVENESS_PATH="$2";  shift 2 ;;
      --readiness)          READINESS_PATH="$2"; shift 2 ;;
      --health-delay)       HEALTH_INITIAL_DELAY="$2"; shift 2 ;;
      --registry)           REGISTRY_ADDRESS="$2"; shift 2 ;;
      --output-dir)         OUTPUT_DIR="$2";     shift 2 ;;
      --non-interactive)    NON_INTERACTIVE="true"; shift ;;
      *) die "Unknown option: $1. Run ./onboard.sh --help" ;;
    esac
  done
}

# ── Prompt helpers ────────────────────────────────────────────────────────────
prompt_required() {
  local var_name="$1" prompt_text="$2"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then return; fi
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    die "Required argument missing: $var_name ($prompt_text). Pass --$(echo "$var_name" | tr '[:upper:]' '[:lower:]') or set $var_name env var."
  fi
  read -rp "  ${prompt_text}: " input
  [[ -n "$input" ]] || die "$var_name cannot be empty"
  printf -v "$var_name" '%s' "$input"
}

prompt_choice() {
  local var_name="$1" prompt_text="$2" choices="$3"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then return; fi
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    die "Required choice missing: $var_name. Options: $choices"
  fi
  read -rp "  ${prompt_text} [${choices}]: " input
  [[ -n "$input" ]] || die "$var_name cannot be empty"
  printf -v "$var_name" '%s' "$input"
}

# ── Validate inputs ───────────────────────────────────────────────────────────
validate() {
  # Validate service name: lowercase slug only
  if ! [[ "$SERVICE_NAME" =~ ^[a-z][a-z0-9-]{1,51}$ ]]; then
    die "Service name must be lowercase alphanumeric + hyphens, 2–52 chars (got: '$SERVICE_NAME')"
  fi

  case "$BUILD_METHOD" in
    buildpacks|dockerfile|auto) ;;
    *) die "Build method must be: buildpacks | dockerfile | auto (got: '$BUILD_METHOD')" ;;
  esac

  case "$DB_MODE" in
    isolated|shared|none) ;;
    *) die "DB mode must be: isolated | shared | none (got: '$DB_MODE')" ;;
  esac

  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 ]] || [[ "$PORT" -gt 65535 ]]; then
    die "Port must be a number 1–65535 (got: '$PORT')"
  fi

  if ! [[ "$REPLICAS" =~ ^[0-9]+$ ]]; then
    die "Replicas must be a positive integer (got: '$REPLICAS')"
  fi
}

# ── Resolve registry address ──────────────────────────────────────────────────
resolve_registry() {
  if [[ -n "$REGISTRY_ADDRESS" ]]; then return; fi

  # Try to read from cluster ConfigMap
  if kubectl get configmap platform-registry -n "$PLATFORM_NAMESPACE" &>/dev/null; then
    REGISTRY_ADDRESS=$(kubectl get configmap platform-registry \
      -n "$PLATFORM_NAMESPACE" \
      -o jsonpath='{.data.registry_address}' 2>/dev/null || echo "")
  fi

  if [[ -z "$REGISTRY_ADDRESS" ]]; then
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      REGISTRY_ADDRESS="localhost:5050"
      warn "Could not read registry from cluster — defaulting to $REGISTRY_ADDRESS"
    else
      read -rp "  Registry address (e.g. localhost:5050): " REGISTRY_ADDRESS
    fi
  fi
}

# ── Collect secret values ─────────────────────────────────────────────────────
# Secret values are NEVER written to disk or any manifest in plaintext.
# They are either:
#   (a) Prompted interactively and piped directly to kubectl
#   (b) Randomly generated (for internal tokens)
# The secret Kubernetes object is created by generate-manifests.sh using
# kubectl create secret, not stored in YAML.
collect_secrets() {
  if [[ ${#SECRET_NAMES[@]} -eq 0 ]]; then return; fi

  declare -g -A SECRET_VALUES=()

  header "Secret values for $SERVICE_NAME"
  echo "  These are never written to disk. Enter values or press Enter to auto-generate."
  echo ""

  for key in "${SECRET_NAMES[@]}"; do
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
      # In CI: expect env var SERVICE_SECRET_<KEY> (all caps)
      local env_var="SERVICE_SECRET_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
      local val="${!env_var:-}"
      if [[ -z "$val" ]]; then
        warn "No env var $env_var found — generating random value for $key"
        val=$(generate_secret_value)
      fi
      SECRET_VALUES["$key"]="$val"
    else
      read -rsp "  $key (blank = auto-generate): " val
      echo ""
      if [[ -z "$val" ]]; then
        val=$(generate_secret_value)
        info "Auto-generated value for $key"
      fi
      SECRET_VALUES["$key"]="$val"
    fi
  done
}

generate_secret_value() {
  # 32 bytes → 43 URL-safe base64 chars; no external deps
  python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null \
    || openssl rand -base64 32 | tr -d '\n' \
    || head -c 32 /dev/urandom | base64 | tr -d '\n='
}

# ── Write onboarding config (no secrets) ─────────────────────────────────────
write_config() {
  local config_file="$OUTPUT_DIR/${SERVICE_NAME}.onboard.conf"
  mkdir -p "$OUTPUT_DIR"

  info "Writing onboarding config → $config_file"
  cat > "$config_file" <<EOF
# Generated by onboard.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit and re-run generate-manifests.sh to regenerate Kubernetes objects.
# NEVER store secret values here.

SERVICE_NAME="${SERVICE_NAME}"
REPO_URL="${REPO_URL}"
BRANCH="${BRANCH}"
BUILD_METHOD="${BUILD_METHOD}"
DB_MODE="${DB_MODE}"
PORT="${PORT}"
REPLICAS="${REPLICAS}"
REGISTRY_ADDRESS="${REGISTRY_ADDRESS}"
LIVENESS_PATH="${LIVENESS_PATH}"
READINESS_PATH="${READINESS_PATH}"
HEALTH_INITIAL_DELAY="${HEALTH_INITIAL_DELAY}"
CPU_REQUEST="${CPU_REQUEST}"
CPU_LIMIT="${CPU_LIMIT}"
MEM_REQUEST="${MEM_REQUEST}"
MEM_LIMIT="${MEM_LIMIT}"
APPS_NAMESPACE="${APPS_NAMESPACE}"

# Non-secret environment variables (KEY=value, one per line)
EOF

  if [[ ${#ENV_VARS[@]} -gt 0 ]]; then
    echo "ENV_VARS=(" >> "$config_file"
    for ev in "${ENV_VARS[@]}"; do
      echo "  $(printf '%q' "$ev")" >> "$config_file"
    done
    echo ")" >> "$config_file"
  else
    echo "ENV_VARS=()" >> "$config_file"
  fi

  if [[ ${#SECRET_NAMES[@]} -gt 0 ]]; then
    echo "" >> "$config_file"
    echo "# Secret key names only — values are NEVER stored here" >> "$config_file"
    echo "SECRET_NAMES=(" >> "$config_file"
    for sn in "${SECRET_NAMES[@]}"; do
      echo "  $(printf '%q' "$sn")" >> "$config_file"
    done
    echo ")" >> "$config_file"
  else
    echo "SECRET_NAMES=()" >> "$config_file"
  fi
}

# ── Create Kubernetes Secret (values in-memory only, never on disk) ──────────
create_k8s_secret() {
  if [[ ${#SECRET_NAMES[@]} -eq 0 ]]; then return; fi

  info "Creating/updating Kubernetes Secret: ${SERVICE_NAME}-secrets"

  # Build kubectl args dynamically
  local args=(create secret generic "${SERVICE_NAME}-secrets"
    -n "$APPS_NAMESPACE"
    --save-config
    --dry-run=client -o yaml)

  for key in "${SECRET_NAMES[@]}"; do
    args+=(--from-literal="${key}=${SECRET_VALUES[$key]}")
  done

  # Pipe YAML to apply so values are never on disk or in process list
  kubectl "${args[@]}" | kubectl apply -f -
  success "Secret ${SERVICE_NAME}-secrets applied to namespace $APPS_NAMESPACE"
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  header "Onboarding complete — $SERVICE_NAME"
  echo ""
  echo "  Repository   : $REPO_URL @ $BRANCH"
  echo "  Build method : $BUILD_METHOD"
  echo "  DB mode      : $DB_MODE"
  echo "  Port         : $PORT"
  echo "  Replicas     : $REPLICAS"
  echo "  Registry     : $REGISTRY_ADDRESS"
  echo "  Namespace    : $APPS_NAMESPACE"
  echo ""
  if [[ ${#ENV_VARS[@]} -gt 0 ]]; then
    echo "  Env vars:"
    for ev in "${ENV_VARS[@]}"; do echo "    $ev"; done
    echo ""
  fi
  if [[ ${#SECRET_NAMES[@]} -gt 0 ]]; then
    echo "  Secrets (values in cluster, not shown):"
    for sn in "${SECRET_NAMES[@]}"; do echo "    $sn"; done
    echo ""
  fi
  echo "  Config saved : $OUTPUT_DIR/${SERVICE_NAME}.onboard.conf"
  echo ""
  echo "  Next steps:"
  echo "    1. Run:  ./build.sh $OUTPUT_DIR/${SERVICE_NAME}.onboard.conf"
  echo "    2. Run:  ./generate-manifests.sh $OUTPUT_DIR/${SERVICE_NAME}.onboard.conf"
  echo "    3. Run:  kubectl apply -f $OUTPUT_DIR/${SERVICE_NAME}/"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  header "Kubernetes Platform — Service Onboarding"

  parse_args "$@"

  # Pick up env var aliases
  REPO_URL="${REPO_URL:-${REPO_URL:-}}"
  BRANCH="${BRANCH:-${BRANCH:-main}}"
  SERVICE_NAME="${SERVICE_NAME:-${SERVICE_NAME:-}}"
  BUILD_METHOD="${BUILD_METHOD:-${BUILD_METHOD:-}}"
  DB_MODE="${DB_MODE:-${DB_MODE:-}}"
  PORT="${PORT:-${SERVICE_PORT:-}}"

  echo ""
  info "Answer prompts below. All values can also be passed as flags (--help)."
  echo ""

  # Collect required inputs interactively if not provided
  prompt_required REPO_URL      "Git repository URL"
  prompt_required SERVICE_NAME  "Service name (lowercase slug, e.g. my-api)"
  prompt_required BRANCH        "Branch (default: main)"
  BRANCH="${BRANCH:-main}"
  prompt_choice  BUILD_METHOD  "Build method" "buildpacks/dockerfile/auto"
  BUILD_METHOD="${BUILD_METHOD:-auto}"
  prompt_choice  DB_MODE       "Database mode" "isolated/shared/none"
  prompt_required PORT          "Container port"

  resolve_registry
  validate
  collect_secrets
  write_config
  create_k8s_secret
  print_summary
}

main "$@"
