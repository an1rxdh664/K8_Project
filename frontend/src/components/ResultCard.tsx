'use client';

import type { ResilienceRun } from '@/types';

interface ResultCardProps {
  run: ResilienceRun;
}

function TestRow({ test }: { test: ResilienceRun['tests'][number] }) {
  const passed = test.status === 'passed';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '7px 0',
      borderBottom: '1px solid var(--border)',
      fontSize: 13,
    }}>
      <span className={`status-dot ${passed ? 'healthy' : 'error'}`} />
      <span style={{ flex: 1, color: 'var(--text)' }}>{test.name}</span>
      {test.recoveryTimeMs !== undefined && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {test.recoveryTimeMs}ms
        </span>
      )}
      <span style={{ fontSize: 11, fontWeight: 600, color: passed ? 'var(--success)' : 'var(--danger)' }}>
        {passed ? 'PASS' : 'FAIL'}
      </span>
    </div>
  );
}

export function ResultCard({ run }: ResultCardProps) {
  const ts = new Date(run.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  const statusColor = run.overallStatus === 'passed'  ? 'var(--success)'
                    : run.overallStatus === 'failed'  ? 'var(--danger)'
                    : 'var(--accent)';
  const badgeCls = run.overallStatus === 'passed'  ? 'badge-success'
                 : run.overallStatus === 'failed'  ? 'badge-danger'
                 : 'badge-accent';

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="status-dot" style={{ background: statusColor }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{run.service}</span>
          <span className={`badge ${badgeCls}`}>{run.overallStatus}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ts}</span>
      </div>

      {/* Test rows */}
      <div>
        {run.tests.map((test, i) => (
          <TestRow key={i} test={test} />
        ))}
      </div>

      {/* Run ID */}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        Run ID: <span style={{ fontFamily: 'monospace' }}>{run.id}</span>
      </div>
    </div>
  );
}
