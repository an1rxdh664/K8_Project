'use client';

import { useFetch } from '@/hooks/useFetch';
import { fetchClusterStatus } from '@/lib/api';
import { StatCard } from './StatCard';
import { Spinner } from './Spinner';
import { useSound } from '@/hooks/useSound';
import { useEffect } from 'react';

function ComponentStatus({ label, status }: { label: string; status: 'running' | 'degraded' | 'unknown' }) {
  const color = status === 'running' ? 'var(--success)' : status === 'degraded' ? 'var(--accent)' : 'var(--text-muted)';
  const dotClass = status === 'running' ? 'healthy' : status === 'degraded' ? 'running' : 'pending';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`status-dot ${dotClass}`} />
        <span style={{ fontSize: 12, color }}>{status}</span>
      </div>
    </div>
  );
}

export function StatusSection() {
  const { data, loading, error, refresh } = useFetch(fetchClusterStatus);
  const { play } = useSound();

  useEffect(() => {
    if (loading) play('tick');
  }, [loading, play]);

  if (loading) {
    return (
      <div>
        <h1 className="section-title">Status</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <Spinner /> Fetching cluster status…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <h1 className="section-title">Status</h1>
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 4 }}>Could not reach backend</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{error}</div>
          </div>
          <button className="btn btn-secondary" onClick={refresh}>Retry</button>
        </div>
      </div>
    );
  }

  const allHealthy = data.healthyServices === data.totalServices;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>Status</h1>
        <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={refresh}>↻ Refresh</button>
      </div>

      {/* Stat cards row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 22 }}>
        <StatCard
          label="Services"
          value={`${data.healthyServices}/${data.totalServices}`}
          sub={allHealthy ? 'All healthy' : `${data.totalServices - data.healthyServices} degraded`}
          subColor={allHealthy ? 'var(--success)' : 'var(--danger)'}
        />
        <StatCard label="Nodes" value={data.nodeCount} sub="in cluster" />
        <StatCard label="K8s" value={data.kubernetesVersion} sub="version" />
        <StatCard label="Registry" value={data.registryAddress} sub="local" />
      </div>

      {/* Cluster info card */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 22 }}>
        <div className="card">
          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 10 }}>
            Cluster
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Name</span>
              <span className="mono">{data.clusterName}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>Namespaces</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data.namespaces.join(', ')}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 10 }}>
            Platform Components
          </div>
          <ComponentStatus label="ArgoCD" status={data.argoCDStatus} />
          <ComponentStatus label="KEDA" status={data.kedaStatus} />
          <ComponentStatus label="Prometheus" status={data.prometheusStatus} />
        </div>
      </div>
    </div>
  );
}
