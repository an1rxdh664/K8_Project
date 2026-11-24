'use client';

import { useFetch } from '@/hooks/useFetch';
import { fetchAllMigrations, fetchServiceNames } from '@/lib/api';
import { Spinner } from './Spinner';
import { useSound } from '@/hooks/useSound';
import { useSSE } from '@/hooks/useSSE';
import { actionRunMigration, type MigrationPhase } from '@/lib/actions';
import { useState, useRef, useEffect } from 'react';
import type { MigrationRun } from '@/types';

const PHASE_ORDER = ['expand', 'verify', 'contract'];

function phaseIcon(phase: string) {
  switch (phase) {
    case 'expand':   return '→';
    case 'verify':   return '✓';
    case 'contract': return '←';
    default:         return '·';
  }
}

function StatusBadge({ status }: { status: MigrationRun['status'] }) {
  const cls = status === 'success' ? 'badge-success' : status === 'failed' ? 'badge-danger' : 'badge-accent';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function MigrationCard({ run }: { run: MigrationRun }) {
  const ts = new Date(run.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      borderBottom: '1px solid var(--border)',
    }}>
      {/* Phase icon */}
      <span style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: 'var(--bg)',
        border: '1px solid var(--border-strong)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        color: 'var(--accent)',
        flexShrink: 0,
        fontWeight: 600,
      }}>
        {phaseIcon(run.phase)}
      </span>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
            {run.phase}
          </span>
          <StatusBadge status={run.status} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{run.id}</span>
        </div>
        {run.notes && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {run.notes}
          </div>
        )}
      </div>

      {/* Timestamp */}
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{ts}</span>
    </div>
  );
}

function GroupedByMigrationId({ runs }: { runs: MigrationRun[] }) {
  const groups: Record<string, MigrationRun[]> = {};
  for (const run of runs) {
    if (!groups[run.id]) groups[run.id] = [];
    groups[run.id].push(run);
  }

  const sortedIds = Object.keys(groups).sort((a, b) => {
    const aTs = groups[a][0]?.timestamp || '';
    const bTs = groups[b][0]?.timestamp || '';
    return bTs.localeCompare(aTs);
  });

  if (sortedIds.length === 0) {
    return (
      <div style={{ padding: '14px', fontSize: 13, color: 'var(--text-muted)' }}>
        No migration history. Trigger a migration phase above to get started.
      </div>
    );
  }

  return (
    <>
      {sortedIds.map(id => {
        const group = groups[id].sort(
          (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)
        );
        const overallOk = group.every(r => r.status === 'success');
        const hasFailure = group.some(r => r.status === 'failed');
        const overallColor = overallOk ? 'var(--success)' : hasFailure ? 'var(--danger)' : 'var(--accent)';

        return (
          <div key={id} style={{ marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px',
              background: 'var(--bg)',
              borderBottom: '1px solid var(--border)',
            }}>
              <span className="status-dot" style={{ background: overallColor }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Migration {id}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {group.length} phase{group.length !== 1 ? 's' : ''}
              </span>
            </div>
            {group.map((run, i) => (
              <MigrationCard key={`${run.id}-${run.phase}-${i}`} run={run} />
            ))}
          </div>
        );
      })}
    </>
  );
}

// ── Live migration trigger panel ───────────────────────────────────────────────

interface RunMigrationPanelProps {
  service: string;
  onDone: () => void;
}

function RunMigrationPanel({ service, onDone }: RunMigrationPanelProps) {
  const { play } = useSound();
  const sse = useSSE();
  const [phase, setPhase] = useState<MigrationPhase>('expand');
  const [migrationId, setMigrationId] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log output
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sse.lines]);

  // Play sound on finish
  useEffect(() => {
    if (!sse.finished) return;
    if (sse.succeeded) {
      play('success');
      setTimeout(onDone, 1500);
    } else {
      play('error');
    }
  }, [sse.finished, sse.succeeded, play, onDone]);

  function trigger() {
    play('click');
    const { url, body } = actionRunMigration(service, phase, migrationId || undefined);
    sse.start(url, body);
  }

  const canRun = !sse.running;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
        Run Migration Phase
      </div>

      {/* Controls row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Phase selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Phase</label>
          <select
            value={phase}
            onChange={e => setPhase(e.target.value as MigrationPhase)}
            disabled={sse.running}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: sse.running ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="expand">→ expand</option>
            <option value="verify">✓ verify</option>
            <option value="contract">← contract</option>
          </select>
        </div>

        {/* Optional migration ID */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Migration ID (optional)</label>
          <input
            type="text"
            placeholder="e.g. 20240101_add_index"
            value={migrationId}
            onChange={e => setMigrationId(e.target.value)}
            disabled={sse.running}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              fontSize: 13,
              width: '100%',
            }}
          />
        </div>

        <button
          className="btn btn-primary"
          disabled={!canRun}
          onClick={trigger}
          style={{ flexShrink: 0 }}
        >
          {sse.running ? <><Spinner size={12} color="#fff" /> Running…</> : '▶ Run Phase'}
        </button>

        {sse.finished && (
          <button
            className="btn btn-secondary"
            onClick={() => { sse.reset(); }}
            style={{ flexShrink: 0, fontSize: 12 }}
          >
            ↺ Reset
          </button>
        )}
      </div>

      {/* SSE log stream */}
      {(sse.running || sse.lines.length > 0 || sse.connectError) && (
        <div style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '10px 12px',
          maxHeight: 220,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--text-muted)',
        }}>
          {sse.connectError && (
            <div style={{ color: 'var(--danger)', marginBottom: 6 }}>
              Connection error: {sse.connectError}
            </div>
          )}
          {sse.lines.map((line, i) => (
            <div key={i} style={{ color: line.toLowerCase().includes('error') || line.toLowerCase().includes('fatal') ? 'var(--danger)' : 'var(--text-muted)' }}>
              {line}
            </div>
          ))}
          {sse.running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', marginTop: 4 }}>
              <Spinner size={10} color="var(--accent)" /> running…
            </div>
          )}
          {sse.finished && (
            <div style={{ marginTop: 6, fontWeight: 600, color: sse.succeeded ? 'var(--success)' : 'var(--danger)' }}>
              {sse.succeeded ? '✓ Phase completed successfully.' : '✗ Phase failed.'}
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}

// ── Main section ───────────────────────────────────────────────────────────────

export function MigrationsSection() {
  const { play } = useSound();
  const { data: names } = useFetch(fetchServiceNames);
  const { data, loading, error, refresh } = useFetch(fetchAllMigrations);
  const [selectedService, setSelectedService] = useState<string>('');

  const allServices = names || (data ? Object.keys(data) : []);
  const displayService = selectedService || allServices[0] || '';
  const runsForService = data?.[displayService] || [];

  if (loading) {
    return (
      <div>
        <h1 className="section-title">Migrations</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <Spinner /> Loading migration history…
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>Migrations</h1>
        <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { play('click'); refresh(); }}>
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>Could not load migrations: {error}</div>
        </div>
      )}

      {/* How expand-contract works */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Expand-Contract Pattern
        </div>
        <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
          {[
            { phase: 'expand', icon: '→', desc: 'Add new columns/tables. Old code still works.' },
            { phase: 'verify', icon: '✓', desc: 'Check data integrity before removing anything.' },
            { phase: 'contract', icon: '←', desc: 'Remove old schema. New code only.' },
          ].map((step, i) => (
            <div key={step.phase} style={{ flex: 1, padding: '10px 12px', borderRight: i < 2 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 14 }}>{step.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>{step.phase}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{step.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Service picker */}
      {allServices.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {allServices.map(svc => (
            <button
              key={svc}
              onClick={() => { play('click'); setSelectedService(svc); }}
              style={{
                padding: '4px 12px',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                border: `1px solid ${displayService === svc ? 'var(--accent)' : 'var(--border)'}`,
                background: displayService === svc ? 'var(--accent-soft)' : 'transparent',
                color: displayService === svc ? 'var(--accent)' : 'var(--text-muted)',
                transition: 'all 150ms ease',
              }}
            >
              {svc}
            </button>
          ))}
        </div>
      )}

      {allServices.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No services found. Onboard a service first.
        </div>
      ) : (
        <>
          {/* Trigger panel */}
          <RunMigrationPanel
            service={displayService}
            onDone={() => refresh()}
          />

          {/* History */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{displayService}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {runsForService.length} run{runsForService.length !== 1 ? 's' : ''}
              </span>
            </div>
            <GroupedByMigrationId runs={runsForService} />
          </div>
        </>
      )}
    </div>
  );
}
