/**
 * actions.ts — typed client for all action (SSE) endpoints.
 *
 * These functions return the URL + body needed to call useSSE.start().
 * They do NOT trigger the fetch themselves — the hook owns the connection.
 *
 * Usage:
 *   const sse = useSSE();
 *   const { url, body } = actionSetupArgocd();
 *   sse.start(url, body, (event) => { ... });
 */

export interface ActionRequest {
  url: string;
  body?: Record<string, unknown>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function actionSetupArgocd(): ActionRequest {
  return { url: '/api/setup/argocd' };
}

export function actionSetupKeda(): ActionRequest {
  return { url: '/api/setup/keda' };
}

export function actionSetupObservability(): ActionRequest {
  return { url: '/api/setup/observability' };
}

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
  /** Secret NAMES only — values are never sent through the API */
  secretNames?: string[];
}

export function actionOnboard(payload: OnboardPayload): ActionRequest {
  return { url: '/api/onboard', body: payload as unknown as Record<string, unknown> };
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

export function actionBuild(service: string, branch?: string): ActionRequest {
  return {
    url: `/api/build/${encodeURIComponent(service)}`,
    body: branch ? { branch } : undefined,
  };
}

export function actionDeploy(
  service: string,
  opts?: { replicas?: number; tag?: string },
): ActionRequest {
  return {
    url: `/api/deploy/${encodeURIComponent(service)}`,
    body: opts ?? undefined,
  };
}

export function actionRegisterGitops(
  service: string,
  opts?: { repoUrl?: string; branch?: string },
): ActionRequest {
  return {
    url: `/api/gitops/${encodeURIComponent(service)}`,
    body: opts ?? undefined,
  };
}

export function actionConfigureAutoscaling(
  service: string,
  opts?: {
    minReplicas?: number;
    maxReplicas?: number;
    metric?: string;
    threshold?: number;
  },
): ActionRequest {
  return {
    url: `/api/autoscaling/${encodeURIComponent(service)}`,
    body: opts ?? undefined,
  };
}

export function actionConfigureMonitoring(
  service: string,
  opts?: { port?: number; path?: string },
): ActionRequest {
  return {
    url: `/api/monitoring/${encodeURIComponent(service)}`,
    body: opts ?? undefined,
  };
}

export function actionRestartService(service: string): ActionRequest {
  return { url: `/api/services/${encodeURIComponent(service)}/restart` };
}

export function actionRotateSecret(service: string, secretName: string): ActionRequest {
  return {
    url: `/api/secrets/${encodeURIComponent(service)}/rotate`,
    body: { secretName },
  };
}

// ── Migrations ────────────────────────────────────────────────────────────────

export type MigrationPhase = 'expand' | 'verify' | 'contract';

export function actionRunMigration(
  service: string,
  phase: MigrationPhase,
  migrationId?: string,
): ActionRequest {
  return {
    url: `/api/migrate/${encodeURIComponent(service)}`,
    body: { phase, ...(migrationId ? { migrationId } : {}) },
  };
}

// ── Resilience ────────────────────────────────────────────────────────────────

export function actionRunResilienceTests(
  service: string,
  tests?: string[],
): ActionRequest {
  return {
    url: `/api/resilience/${encodeURIComponent(service)}/run`,
    body: tests?.length ? { tests } : undefined,
  };
}
