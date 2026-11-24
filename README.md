# Kubernetes Microservices Platform

Generic platform for onboarding, building, and running any service on a local Kubernetes cluster.
**Nothing about any specific service is hardcoded** — all values come from CLI arguments or interactive prompts.

---

## Prerequisites

| Tool | Required for | Notes |
|------|-------------|-------|
| Docker | All phases | Running daemon |
| k3d **or** kind | Phase 1A | k3d preferred |
| kubectl | All phases | Configured automatically by setup |
| pack (Paketo) | Phase 1C | `brew install buildpacks/tap/pack` |
| helm | Phase 2B | `brew install helm` (optional — falls back to manifest) |
| ArgoCD CLI | Phase 2A | Optional — UI + kubectl are sufficient |

---

## Directory layout (single flat directory)

```
.
├── setup-cluster.sh        # 1A — create cluster + registry + namespaces + RBAC
├── teardown-cluster.sh     # 1A — destroy cluster
├── rbac.yaml               # 1A — platform RBAC (applied by setup-cluster.sh)
├── registry-config.yaml    # 1A — registry address ConfigMap
│
├── onboard.sh              # 1B — register a new service (interactive or scripted)
├── rotate-secret.sh        # 1B — rotate a secret key for any service
├── list-services.sh        # 1B — list all onboarded services and cluster status
│
├── build.sh                # 1C — build image (buildpacks first, Dockerfile fallback)
│
├── generate-manifests.sh   # 1D — generate Deployment/Service/ConfigMap/RBAC YAML
│
├── setup-argocd.sh         # 2A — install ArgoCD into cluster
├── argocd-rbac.yaml        # 2A — ArgoCD permissions for apps namespace
├── gitops-register.sh      # 2A — register a service as an ArgoCD Application
│
├── setup-keda.sh           # 2B — install KEDA into cluster
├── configure-autoscaling.sh# 2B — generate ScaledObject for a service
│
├── run-migration.sh        # 2C — run expand/verify/contract migration Jobs
│
├── setup-observability.sh  # 2D — install Prometheus + Grafana
├── observability-rbac.yaml # 2D — Prometheus scraping permissions
├── grafana-dashboard.yaml  # 2D — platform-wide Grafana overview dashboard
├── configure-monitoring.sh # 2D — generate ServiceMonitor + per-service dashboard
│
├── run-resilience-tests.sh # 2E — pod failure, network partition, resource exhaustion tests
│
├── start-dashboard.sh      # 3  — start Next.js dashboard + backend API
├── frontend/               # 3  — Next.js + Tailwind dashboard UI
│   ├── src/
│   │   ├── app/            # Next.js App Router (layout, page, globals.css)
│   │   ├── components/     # Sidebar, StatCard, StatusSection, ServicesSection …
│   │   ├── hooks/          # useSound (Web Audio API), useFetch
│   │   ├── lib/            # api.ts — typed fetch client
│   │   └── types/          # shared TypeScript types
│   ├── package.json
│   ├── next.config.js
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── backend/                # 3  — Express API (reads cluster state via kubectl)
│   ├── server.js           # API routes: /api/status /api/services /api/logs …
│   ├── cluster.js          # cluster state aggregation
│   ├── kubectl.js          # kubectl wrapper (never touches secrets)
│   └── package.json
│
├── README.md               # this file
└── manifests/              # generated per-service config + Kubernetes YAML
    ├── <service>.onboard.conf      # onboarding config (no secrets)
    ├── <service>.build.result      # image ref + build method used
    └── <service>/
        ├── 01-serviceaccount.yaml
        ├── 02-rbac.yaml
        ├── 03-configmap.yaml
        ├── 04-deployment.yaml
        ├── 05-service.yaml
        ├── 06-argocd-app.yaml      # 2A — ArgoCD Application
        ├── 07-scaledobject.yaml    # 2B — KEDA ScaledObject
        ├── 08-servicemonitor.yaml  # 2D — Prometheus ServiceMonitor
        ├── 09-grafana-dashboard.yaml # 2D — per-service Grafana dashboard ConfigMap
        └── kustomization.yaml
```

---

## Quick start (complete flow)

### 1. Create the cluster

```bash
./setup-cluster.sh
```

Customise with environment variables:
```bash
CLUSTER_NAME=my-cluster REGISTRY_PORT=5050 ./setup-cluster.sh
```

What it creates:
- k3d (or kind) local cluster with 1 worker node
- Local Docker registry at `localhost:5050`
- Namespaces: `platform`, `apps`, `observability`
- Least-privilege RBAC for platform controller and dashboard
- ConfigMap storing the registry address in-cluster

---

### 2. Onboard a service

```bash
./onboard.sh
# Interactive prompts guide you through all options
```

Or fully scripted (CI/CD, `--non-interactive`):
```bash
./onboard.sh \
  --repo https://github.com/acme/api \
  --name my-api \
  --build-method buildpacks \
  --db-mode isolated \
  --port 8080 \
  --env LOG_LEVEL=info \
  --secret DB_PASSWORD \
  --non-interactive
```

What it does:
- Writes `manifests/my-api.onboard.conf` (no secrets in this file)
- Creates `my-api-secrets` Kubernetes Secret in-memory and applies it directly
  — values are **never written to disk or any YAML file**

---

### 3. Build the image

```bash
./build.sh manifests/my-api.onboard.conf
```

Build strategy (in order):
1. **Cloud Native Buildpacks** (Paketo) — if `pack` CLI is available
2. **Dockerfile** — if a `Dockerfile` is found in the repo root
3. **Error** — clear message, no silent fallback

Additional options:
```bash
BUILD_TAG=v1.2.3 ./build.sh manifests/my-api.onboard.conf   # pin tag
SKIP_SMOKE=true  ./build.sh manifests/my-api.onboard.conf   # skip smoke test
```

The smoke test starts the container locally, hits `GET /healthz`, and removes it — purely a disposable check.

---

### 4. Generate and apply manifests

```bash
./generate-manifests.sh manifests/my-api.onboard.conf

# Apply with kustomize (guaranteed order):
kubectl apply -k manifests/my-api/

# Or preview first:
DRY_RUN=true ./generate-manifests.sh manifests/my-api.onboard.conf
```

What is generated per service:
| File | Contents |
|------|----------|
| `01-serviceaccount.yaml` | Dedicated SA, no auto-token mount |
| `02-rbac.yaml` | Least-privilege Role + RoleBinding |
| `03-configmap.yaml` | Non-secret env vars + platform metadata |
| `04-deployment.yaml` | Deployment with probes, resource limits, security context |
| `05-service.yaml` | ClusterIP Service |
| `kustomization.yaml` | Apply order |

**Secret YAML is never generated.** The Secret was created by `onboard.sh` and lives only in the cluster.

---

### 5. Verify

```bash
kubectl get deployments -n apps
kubectl get pods -n apps
kubectl logs -n apps -l app.kubernetes.io/name=my-api
./list-services.sh
```

---

## GitOps (Phase 2A — ArgoCD)

### Install ArgoCD

```bash
./setup-argocd.sh
# With port-forward kept running:
./setup-argocd.sh --port-forward
```

### Register a service with ArgoCD

```bash
./gitops-register.sh manifests/my-api.onboard.conf
# Generates 06-argocd-app.yaml and applies it
```

Sync policy defaults to `automated` (auto-prune + self-heal). Override:
```bash
SYNC_POLICY=manual ./gitops-register.sh manifests/my-api.onboard.conf
```

ArgoCD ignores replica count changes (KEDA manages those) — no sync conflicts.

### Deregister

```bash
./gitops-register.sh --deregister my-api
# Cascade-deletes cluster resources via finalizer
```

---

## Autoscaling (Phase 2B — KEDA)

### Install KEDA

```bash
./setup-keda.sh
# Specific version:
./setup-keda.sh --version 2.15.1
```

### Add autoscaling to a service

```bash
# CPU-based (default):
./configure-autoscaling.sh manifests/my-api.onboard.conf

# Custom trigger:
./configure-autoscaling.sh manifests/my-api.onboard.conf --trigger http --max 20

# Memory-based, preview only:
./configure-autoscaling.sh manifests/my-api.onboard.conf --trigger memory --no-apply
```

| Trigger | When to use |
|---------|-------------|
| `cpu` | General workloads (default) |
| `memory` | Memory-intensive processing |
| `http` | HTTP services with KEDA HTTP add-on |
| `cron` | Predictable traffic patterns |

KEDA owns replica count — ArgoCD is configured to ignore it (no sync wars).

---

## Migrations (Phase 2C — Expand-Contract)

Migrations run as Kubernetes Jobs — no long-lived migration containers. Results are stored in a ConfigMap so the dashboard (Phase 3) can read them.

### Run a migration

```bash
# Single phase:
./run-migration.sh manifests/my-api.onboard.conf --phase expand
./run-migration.sh manifests/my-api.onboard.conf --phase verify
./run-migration.sh manifests/my-api.onboard.conf --phase contract

# All phases in sequence (with confirmation prompts):
./run-migration.sh manifests/my-api.onboard.conf --phase all

# Non-interactive (CI):
NON_INTERACTIVE=true ./run-migration.sh manifests/my-api.onboard.conf --phase all
```

| Phase | What happens | When to run |
|-------|-------------|-------------|
| `expand` | Adds new columns/tables (backward-compatible) | Before deploying new code |
| `verify` | Asserts expand succeeded | After expand, before contract |
| `contract` | Removes old columns/tables | After all pods run new code |

### Custom migration commands

By default the Job runs `migrate-expand`, `migrate-verify`, `migrate-contract` inside your container. Override:
```bash
MIGRATION_CMD_EXPAND="python manage.py migrate --phase expand" \
  ./run-migration.sh manifests/my-api.onboard.conf --phase expand
```

### View history

```bash
./run-migration.sh --history my-api
```

---

## Observability (Phase 2D — Prometheus + Grafana)

### Install the stack

```bash
./setup-observability.sh
# Keep port-forwards running:
./setup-observability.sh --port-forward
```

Default Grafana password: `platform-local`. Override:
```bash
GRAFANA_PASSWORD=mysecret ./setup-observability.sh
```

### Add monitoring to a service

```bash
./configure-monitoring.sh manifests/my-api.onboard.conf
# Custom metrics path/port:
./configure-monitoring.sh manifests/my-api.onboard.conf --metrics-path /metrics --metrics-port 9090
```

Generates `08-servicemonitor.yaml` and `09-grafana-dashboard.yaml` per service.

### Access

```bash
# Prometheus:
kubectl port-forward svc/prometheus-kube-prometheus-prometheus -n observability 9090:9090
# → http://localhost:9090

# Grafana:
kubectl port-forward svc/prometheus-grafana -n observability 3000:80
# → http://localhost:3000  (admin / platform-local)
```

---

## Resilience Tests (Phase 2E)

```bash
# Run all three tests:
./run-resilience-tests.sh manifests/my-api.onboard.conf

# Run one test:
./run-resilience-tests.sh manifests/my-api.onboard.conf --test pod-failure

# View history:
./run-resilience-tests.sh --results my-api
```

| Test | What it does | Pass condition |
|------|-------------|---------------|
| `pod-failure` | Force-kills a pod | Replacement ready within timeout |
| `network-partition` | Blocks all egress via NetworkPolicy | Pods stay Running; healthy after removal |
| `resource-exhaustion` | Sends sustained requests for 20s | No OOMKill or CrashLoop; pods still ready |

Results written to `manifests/<service>.resilience-results.json` and stored in a ConfigMap for the dashboard.

---

## Dashboard (Phase 3)

A Next.js + Tailwind dashboard that reads live cluster state through the backend API.

### Start

```bash
./start-dashboard.sh
# Dev mode (hot reload, no build step):
./start-dashboard.sh --dev
# Custom ports:
FRONTEND_PORT=4000 BACKEND_PORT=4001 ./start-dashboard.sh
```

Then open: **http://localhost:3000**

### What it shows

| Section | Data source |
|---------|-------------|
| **Status** | Cluster info, component health (ArgoCD / KEDA / Prometheus) |
| **Services** | Live Deployments from `apps` namespace |
| **Logs** | Pod logs streamed via kubectl (`--tail=100`) |
| **Migrations** | Parsed from `<service>-migration-history` ConfigMap |
| **Resilience Tests** | Parsed from `<service>-resilience-results` ConfigMap |

### Architecture

```
browser  →  Next.js (port 3000)  →  Express backend (port 3001)  →  kubectl  →  cluster
```

- The Next.js rewrite proxies `/api/*` to the backend — no CORS issues.
- The backend calls `kubectl` for all cluster reads; it never reads or writes secrets.
- Sounds use the Web Audio API — synthesised inline, no network requests.

### Environment variables (backend)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Backend listen port |
| `KUBECONFIG` | `~/.kube/config` | Cluster credentials |
| `CLUSTER_NAME` | `platform-cluster` | Displayed in Status section |
| `PLATFORM_NS` | `platform` | Namespace for registry ConfigMap |
| `APPS_NS` | `apps` | Namespace for services + ConfigMaps |
| `OBS_NS` | `observability` | Namespace for Prometheus status check |

---

## Other operations

### Rotate a secret

```bash
./rotate-secret.sh --service my-api --key DB_PASSWORD
# Prompted for new value, or auto-generated. Never touches disk.
```

### Teardown

```bash
./teardown-cluster.sh
```

---

## Security model

| Concern | How it's handled |
|---------|-----------------|
| Secrets on disk | Never — values collected in-memory, applied via `kubectl` pipe |
| Secrets in YAML | Never — Secret YAML is not generated |
| CI secrets | Via `SERVICE_SECRET_<KEY>` environment variables |
| Service permissions | Per-service Role with no permissions by default; expanded only as needed |
| Platform permissions | Scoped to `apps` and `platform` namespaces only — no cluster-admin |
| Container security | `runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities dropped |
| Secret rotation | `rotate-secret.sh` — in-memory patch, never on disk |

---

## Global environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLUSTER_NAME` | `k8s-platform` | Cluster name |
| `REGISTRY_NAME` | `platform-registry` | Registry container name |
| `REGISTRY_PORT` | `5050` | Local registry port |
| `APPS_NAMESPACE` | `apps` | Namespace for onboarded services |
| `PLATFORM_NAMESPACE` | `platform` | Namespace for platform components |
| `OBS_NAMESPACE` | `observability` | Namespace for observability stack (Phase 2) |
| `NON_INTERACTIVE` | `false` | Skip all prompts (for CI) |
| `DRY_RUN` | `false` | Print manifests without applying |
| `SKIP_SMOKE` | `false` | Skip smoke test after build |
| `BUILD_TAG` | git SHA | Override image tag |
| `PAKETO_BUILDER` | `paketobuildpacks/builder-jammy-base` | Buildpacks builder image |
| `ARGOCD_NAMESPACE` | `argocd` | ArgoCD installation namespace |
| `ARGOCD_VERSION` | `stable` | ArgoCD version to install |
| `ARGOCD_PORT` | `8080` | Local port-forward port for ArgoCD UI |
| `SYNC_POLICY` | `automated` | ArgoCD sync policy: `automated` or `manual` |
| `KEDA_NAMESPACE` | `keda` | KEDA installation namespace |
| `KEDA_VERSION` | `2.15.1` | KEDA version to install |
| `TRIGGER_TYPE` | `cpu` | KEDA trigger: `cpu`, `memory`, `http`, `cron` |
| `MIN_REPLICAS` | `1` | Minimum replicas for ScaledObject |
| `MAX_REPLICAS` | `10` | Maximum replicas for ScaledObject |
| `JOB_TIMEOUT` | `300` | Seconds to wait for migration Job to complete |
| `METRICS_PATH` | `/metrics` | Prometheus scrape path |
| `SCRAPE_INTERVAL` | `15s` | Prometheus scrape interval |
| `GRAFANA_PASSWORD` | `platform-local` | Grafana admin password |
| `PROMETHEUS_PORT` | `9090` | Local port-forward for Prometheus |
| `GRAFANA_PORT` | `3000` | Local port-forward for Grafana |
| `FRONTEND_PORT` | `3000` | Dashboard UI port |
| `BACKEND_PORT` | `3001` | Dashboard API port |
