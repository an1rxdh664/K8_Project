export type NavSection =
  | 'status'
  | 'services'
  | 'logs'
  | 'migrations'
  | 'resilience'
  | 'setup'
  | 'onboard';

export interface ServiceInfo {
  name: string;
  namespace: string;
  replicas: { ready: number; desired: number };
  image: string;
  repo: string;
  branch: string;
  buildMethod: string;
  dbMode: string;
  port: number;
  status: 'healthy' | 'degraded' | 'error' | 'unknown';
  lastDeployedAt?: string;
}

export interface ClusterStatus {
  clusterName: string;
  registryAddress: string;
  namespaces: string[];
  totalServices: number;
  healthyServices: number;
  nodeCount: number;
  kubernetesVersion: string;
  argoCDStatus: 'running' | 'degraded' | 'unknown';
  kedaStatus: 'running' | 'degraded' | 'unknown';
  prometheusStatus: 'running' | 'degraded' | 'unknown';
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  pod: string;
  message: string;
}

export interface MigrationRun {
  id: string;
  service: string;
  phase: 'expand' | 'verify' | 'contract';
  status: 'success' | 'failed' | 'running';
  timestamp: string;
  notes?: string;
}

export interface ResilienceRun {
  id: string;
  service: string;
  timestamp: string;
  overallStatus: 'passed' | 'failed' | 'partial';
  tests: {
    name: string;
    status: 'passed' | 'failed';
    recoveryTimeMs?: number;
    details?: string;
  }[];
}

export interface StepState {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'failed';
  detail?: string;
}

/** Onboard form state — matches the POST /api/onboard body */
export interface OnboardForm {
  repoUrl: string;
  branch: string;
  serviceName: string;
  buildMethod: 'auto' | 'buildpacks' | 'dockerfile';
  dbMode: 'none' | 'isolated' | 'shared';
  port: string;
  replicas: string;
  envVars: { key: string; value: string }[];
  /** Secret NAMES only — values are never entered here */
  secretNames: string[];
}
