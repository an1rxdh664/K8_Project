'use client';

import { useFetch } from '@/hooks/useFetch';
import { fetchServices } from '@/lib/api';
import { Spinner } from './Spinner';
import { useSound } from '@/hooks/useSound';
import { useSSE } from '@/hooks/useSSE';
import { actionRestartService } from '@/lib/actions';
import { useEffect, useRef, useState } from 'react';
import type { ServiceInfo } from '@/types';

function statusColor(s: ServiceInfo['status']): string {
  switch (s) {
    case 'healthy':  return 'var(--success)';
    case 'degraded': return 'var(--accent)';
    case 'error':    return 'var(--danger)';
    default:         return 'var(--text-muted)';
  }
}

function statusDotClass(s: ServiceInfo['status']): string {
  switch (s) {
    case 'healthy':  return 'healthy';
    case 'degraded': return 'running';
    case 'error':    return 'error';
    default:         return 'pending';
  }
}

function ReplicaBar({ ready, desired }: { ready: number; desired: number }) {
  const pct = desired === 0 ? 0 : Math.round((ready / desired) * 100);
  const color = pct === 100 ? 'var(--success)' : pct === 0 ? 'var(--danger)' : 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="progress-bar" style={{ width: 60, flexShrink: 0 }}>
        <div className="progress-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ready}/{desired}</span>
    </div>
  );
}

// ── Inline SSE log panel ───────────────────────────────────────────────────────

interface ActionLogPanelProps {
  lines: string[];
  running: boolean;
  finished: boolean;
  succeeded: boolean | null;
  connectError: string | null;
  onClose: () => void;
}

function ActionLogPanel({ lines, running, finished, succeeded, connectError, onClose }: ActionLogPanelProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div style={{
      marginTop: 10,
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '10px 12px',
      maxHeight: 160,
      overflowY: 'auto',
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      {connectError && (
        <div style={{ color: 'var(--danger)', marginBottom: 6 }}>
          Connection error: {connectError}
        </div>
      )}
      {lines.map((line, i) => (
        <div key={i} style={{ color: line.toLowerCase().includes('error') || line.toLowerCase().includes('fatal') ? 'var(--danger)' : 'var(--text-muted)' }}>
          {line}
        </div>
      ))}
      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', marginTop: 4 }}>
          <Spinner size={10} color="var(--accent)" /> in progress…
        </div>
      )}
      {finished && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontWeight: 600, color: succeeded ? 'var(--success)' : 'var(--danger)' }}>
            {succeeded ? '✓ Done.' : '✗ Failed.'}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}
          >
            dismiss
          </button>
        </div>
      )}
      <div ref={logEndRef} />
    </div>
  );
}

// ── Per-service action card ────────────────────────────────────────────────────

interface ServiceActionCardProps {
  svc: ServiceInfo;
  onActionDone: () => void;
}

function ServiceActionCard({ svc, onActionDone }: ServiceActionCardProps) {
  const { play } = useSound();
  const sse = useSSE();
  const [activeAction, setActiveAction] = useState<'restart' | 'rollback' | null>(null);

  useEffect(() => {
    if (!sse.finished) return;
    if (sse.succeeded) {
      play('success');
      setTimeout(onActionDone, 1200);
    } else {
      play('error');
    }
  }, [sse.finished, sse.succeeded, play, onActionDone]);

  function handleRestart() {
    play('click');
    setActiveAction('restart');
    const { url, body } = actionRestartService(svc.name);
    sse.start(url, body);
  }

  function handleRollback() {
    play('click');
    setActiveAction('rollback');
    // Rollback uses the deploy endpoint with a "rollback" flag; adjust if
    // the backend exposes a dedicated route.
    sse.start(`/api/deploy/${encodeURIComponent(svc.name)}`, { rollback: true });
  }

  function dismiss() {
    setActiveAction(null);
    sse.reset();
  }

  const busy = sse.running;

  return (
    <div className="card">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{svc.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{svc.image}</div>
        </div>
        <span className={`status-dot ${statusDotClass(svc.status)}`} />
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        <div>Port <strong style={{ color: 'var(--text)' }}>{svc.port}</strong></div>
        <div>Replicas <strong style={{ color: 'var(--text)' }}>{svc.replicas.ready}/{svc.replicas.desired}</strong></div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={handleRestart}
          style={{ fontSize: 12 }}
          title="kubectl rollout restart"
        >
          {busy && activeAction === 'restart' ? <><Spinner size={10} color="var(--text-muted)" /> Restarting…</> : '↺ Restart'}
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={handleRollback}
          style={{ fontSize: 12 }}
          title="kubectl rollout undo"
        >
          {busy && activeAction === 'rollback' ? <><Spinner size={10} color="var(--text-muted)" /> Rolling back…</> : '⟵ Rollback'}
        </button>
      </div>

      {/* Inline log stream */}
      {(sse.running || sse.lines.length > 0 || sse.connectError) && (
        <ActionLogPanel
          lines={sse.lines}
          running={sse.running}
          finished={sse.finished}
          succeeded={sse.succeeded}
          connectError={sse.connectError}
          onClose={dismiss}
        />
      )}
    </div>
  );
}

// ── Main section ───────────────────────────────────────────────────────────────

export function ServicesSection() {
  const { data, loading, error, refresh } = useFetch(fetchServices);
  const { play } = useSound();

  useEffect(() => { if (loading) play('tick'); }, [loading, play]);

  if (loading) {
    return (
      <div>
        <h1 className="section-title">Services</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <Spinner /> Loading services…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <h1 className="section-title">Services</h1>
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 4 }}>Could not load services</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{error}</div>
          </div>
          <button className="btn btn-secondary" onClick={refresh}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>Services</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data.length} onboarded</span>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { play('click'); refresh(); }}>↻ Refresh</button>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No services onboarded yet. Use the Onboard section to add one.
        </div>
      ) : (
        <>
          {/* Summary table */}
          <div className="card" style={{ padding: 0, marginBottom: 18 }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>Replicas</th>
                    <th>Build</th>
                    <th>DB Mode</th>
                    <th>Repo</th>
                    <th>Deployed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((svc) => (
                    <tr key={svc.name}>
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{svc.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{svc.namespace}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className={`status-dot ${statusDotClass(svc.status)}`} />
                          <span style={{ fontSize: 12, color: statusColor(svc.status) }}>{svc.status}</span>
                        </div>
                      </td>
                      <td><ReplicaBar ready={svc.replicas.ready} desired={svc.replicas.desired} /></td>
                      <td><span className="badge badge-muted">{svc.buildMethod}</span></td>
                      <td>
                        <span className={`badge ${svc.dbMode === 'none' ? 'badge-muted' : 'badge-accent'}`}>
                          {svc.dbMode}
                        </span>
                      </td>
                      <td>
                        <a
                          href={svc.repo}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}
                          onClick={() => play('click')}
                        >
                          {svc.branch}
                        </a>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {svc.lastDeployedAt
                            ? new Date(svc.lastDeployedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                            : '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-service cards with restart / rollback */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {data.map((svc) => (
              <ServiceActionCard
                key={svc.name}
                svc={svc}
                onActionDone={refresh}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
