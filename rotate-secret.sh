#!/usr/bin/env bash
# rotate-secret.sh
# Rotates one or more secret keys for an already-onboarded service.
# Values are never written to disk — handled in-memory and piped to kubectl.
#
# Usage:
#   ./rotate-secret.sh --service my-api --key DB_PASSWORD
#   ./rotate-secret.sh --service my-api --key DB_PASSWORD --value "newval"

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

SERVICE_NAME=""
KEY_NAME=""
NEW_VALUE=""
APPS_NAMESPACE="${APPS_NAMESPACE:-apps}"

usage() {
  cat <<EOF
Usage: ./rotate-secret.sh --service <name> --key <KEY_NAME> [--value <val>]

  --service  Service name (matches Kubernetes Secret: <service>-secrets)
  --key      Secret key to rotate
  --value    New value (blank = auto-generate)
  --help     Show this help
EOF
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --service) SERVICE_NAME="$2"; shift 2 ;;
      --key)     KEY_NAME="$2";     shift 2 ;;
      --value)   NEW_VALUE="$2";    shift 2 ;;
      --help|-h) usage ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

generate_secret_value() {
  python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null \
    || openssl rand -base64 32 | tr -d '\n'
}

main() {
  parse_args "$@"
  [[ -n "$SERVICE_NAME" ]] || die "--service is required"
  [[ -n "$KEY_NAME" ]]     || die "--key is required"

  local secret_name="${SERVICE_NAME}-secrets"

  # Verify secret exists
  kubectl get secret "$secret_name" -n "$APPS_NAMESPACE" &>/dev/null \
    || die "Secret $secret_name not found in namespace $APPS_NAMESPACE"

  # Get or prompt new value
  if [[ -z "$NEW_VALUE" ]]; then
    read -rsp "  New value for $KEY_NAME (blank = auto-generate): " NEW_VALUE
    echo ""
    if [[ -z "$NEW_VALUE" ]]; then
      NEW_VALUE=$(generate_secret_value)
      info "Auto-generated new value for $KEY_NAME"
    fi
  fi

  # Patch in-memory, never on disk
  kubectl patch secret "$secret_name" \
    -n "$APPS_NAMESPACE" \
    --type='json' \
    -p="[{\"op\":\"replace\",\"path\":\"/data/${KEY_NAME}\",\"value\":\"$(echo -n "$NEW_VALUE" | base64 | tr -d '\n')\"}]"

  success "Rotated $KEY_NAME in $secret_name"
  info "Restart pods to pick up new value:"
  echo "  kubectl rollout restart deployment/${SERVICE_NAME} -n $APPS_NAMESPACE"
}

main "$@"
