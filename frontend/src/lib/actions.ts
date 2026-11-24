/**
 * actions.ts — typed client for all action (SSE) endpoints.  (fixed version)
 *
 * Why URLs are now absolute:
 *   Long-running actions (build, onboard, migrations) stream output for minutes.
 *   Next.js `rewrites()` proxy requests with a short default timeout and may
 *   buffer/compress the body, so the stream was cut mid-build and the UI then
 *   reported "success" (useSSE treats an ended stream as success).
 *   The backend already has CORS enabled, so the browser can call it directly.
 *
 * Configure with frontend/.env.local:
 *   NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
 */

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const u = (p: string) => `${BACKEND}${p}`;
const seg = encodeURIComponent;

export interface ActionRequest {
  url: string;
  body?: Record<string, unknown>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
export const actionSetupArgocd = (): ActionRequest => ({ url: u('/api/setup/argocd') });
export const actionSetupKeda = (): ActionRequest => ({ url: u('/api/setup/keda') });
export const actionSetupObservability = (): ActionRequest => ({ url: u('/api/setup/observability') });

// ── Onboard ───────────────────────────────────────────────────────────────────
export interface OnboardPayload {
  repoUrl: string;
  branch: string;
  serviceName: string;
  buildMethod?: 'auto' | 'buildpacks' | 'dockerfile';
  dbMode?: 'none' | 'isolated' | 'shared';
  port?: number;
  replicas?: number;
  envVars?: { key: string; value: string }[];
  /** Secret NAMES only — values are generated server-side and never sent through the API */
  secretNames?: string[];
}

export const actionOnboard = (payload: OnboardPayload): ActionRequest => ({
  url: u('/api/onboard'),
  body: payload as unknown as Record<string, unknown>,
});

// ── Service lifecycle ─────────────────────────────────────────────────────────
export const actionBuild = (service: string, branch?: string): ActionRequest => ({
  url: u(`/api/build/${seg(service)}`),
  body: branch ? { branch } : undefined,
});

export const actionDeploy = (service: string, opts?: { replicas?: number }): ActionRequest => ({
  url: u(`/api/deploy/${seg(service)}`),
  body: opts ?? undefined,
});

export const actionRegisterGitops = (
  service: string,
  opts?: { repoUrl?: string; branch?: string },
): ActionRequest => ({ url: u(`/api/gitops/${seg(service)}`), body: opts ?? undefined });

export const actionConfigureAutoscaling = (
  service: string,
  opts?: { minReplicas?: number; maxReplicas?: number; trigger?: 'cpu' | 'memory' | 'http' | 'cron'; threshold?: number },
): ActionRequest => ({ url: u(`/api/autoscaling/${seg(service)}`), body: opts ?? undefined });

export const actionConfigureMonitoring = (
  service: string,
  opts?: { port?: number; path?: string },
): ActionRequest => ({ url: u(`/api/monitoring/${seg(service)}`), body: opts ?? undefined });

export const actionRestartService = (service: string): ActionRequest => ({
  url: u(`/api/services/${seg(service)}/restart`),
});

export const actionRotateSecret = (service: string, secretName: string): ActionRequest => ({
  url: u(`/api/secrets/${seg(service)}/rotate`),
  body: { secretName },
});

// ── Migrations ────────────────────────────────────────────────────────────────
export type MigrationPhase = 'expand' | 'verify' | 'contract';

export const actionRunMigration = (
  service: string,
  phase: MigrationPhase,
  migrationId?: string,
): ActionRequest => ({
  url: u(`/api/migrate/${seg(service)}`),
  body: { phase, ...(migrationId ? { migrationId } : {}) },
});

// ── Resilience ────────────────────────────────────────────────────────────────
export const actionRunResilienceTests = (service: string, tests?: string[]): ActionRequest => ({
  url: u(`/api/resilience/${seg(service)}/run`),
  body: tests?.length ? { tests } : undefined,
});