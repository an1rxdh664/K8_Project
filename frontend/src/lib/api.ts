// All API calls go through Next.js rewrites → backend at BACKEND_URL

const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchClusterStatus() {
  return get<import('@/types').ClusterStatus>('/status');
}

export async function fetchServices() {
  return get<import('@/types').ServiceInfo[]>('/services');
}

export async function fetchLogs(service: string, lines = 100) {
  return get<import('@/types').LogEntry[]>(`/logs/${service}?lines=${lines}`);
}

export async function fetchServiceNames() {
  return get<string[]>('/services/names');
}

export async function fetchMigrationHistory(service: string) {
  return get<import('@/types').MigrationRun[]>(`/migrations/${service}`);
}

export async function fetchAllMigrations() {
  return get<Record<string, import('@/types').MigrationRun[]>>('/migrations');
}

export async function fetchResilienceResults(service: string) {
  return get<import('@/types').ResilienceRun[]>(`/resilience/${service}`);
}

export async function fetchAllResilienceResults() {
  return get<Record<string, import('@/types').ResilienceRun[]>>('/resilience');
}
