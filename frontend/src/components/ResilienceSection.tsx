'use client';

import { useState, useEffect, useRef } from 'react';
import { useFetch } from '@/hooks/useFetch';
import { fetchAllResilienceResults, fetchServiceNames } from '@/lib/api';
import { Spinner } from './Spinner';
import { StepList } from './StepList';
import { ResultCard } from './ResultCard';
import { useSound } from '@/hooks/useSound';
import { useSSE } from '@/hooks/useSSE';
import { actionRunResilienceTests } from '@/lib/actions';
import type { StepState, ResilienceRun } from '@/types';

const TEST_NAMES = ['pod-failure', 'network-partition', 'resource-exhaustion'];

const TEST_DESCRIPTIONS: Record<string, string> = {
  'pod-failure':          'Force-kills a pod and measures how fast it recovers.',
  'network-partition':    'Blocks all egress from service pods for 10 s via NetworkPolicy.',
  'resource-exhaustion':  'Sends sustained requests for 20 s; checks for OOMKill / CrashLoop.',
};

function buildStepsFromRun(run: ResilienceRun): StepState[] {
  return run.tests.map(t => ({
    id: t.name,
    label: t.name,
    status: t.status === 'passed' ? 'done' : t.status === 'failed' ? 'failed' : 'pending',
    detail: t.recoveryTimeMs !== undefined ? `${t.recoveryTimeMs} ms recovery` : t.details,
  }));
}

// ── Live run panel (SSE-driven) ───────────────────────────────────────────────

interface LiveRunPanelProps {
  service: string;
  onDone: () => void;
}

function LiveRunPanel({ service, onDone }: LiveRunPanelProps) {
  const { play } = useSound();
  const sse = useSSE();

  // Steps start as pending; we advance them as SSE progress events arrive
  const [steps, setSteps] = useState<StepState[]>(
    TEST_NAMES.map(n => ({ id: n, label: n, status: 'pending', detail: TEST_DESCRIPTIONS[n] }))
  );
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sse.lines]);

  // Handle SSE events to drive step states
  function handleEvent(e: import('@/hooks/useSSE').SSEEvent) {
    if (e.type === 'progress') {
      setProgress(e.pct);
      // Map step name from progress event
      const stepName = e.step;
      setSteps(prev => prev.map(s => {
        if (s.id === stepName) return { ...s, status: 'active' };
        // Mark any step before this one as done if it was active
        const stepIdx = TEST_NAMES.indexOf(stepName);
        const sIdx = TEST_NAMES.indexOf(s.id);
        if (sIdx < stepIdx && s.status === 'active') return { ...s, status: 'done' };
        return s;
      }));
      setStatusMsg(`Running ${stepName}…`);
      play('tick');
    }
    if (e.type === 'log') {
      // Try to detect per-test completion from log lines
      for (const name of TEST_NAMES) {
        if (e.line.includes(name)) {
          const passed = e.line.toLowerCase().includes('passed') || e.line.toLowerCase().includes('ok');
          const failed = e.line.toLowerCase().includes('failed') || e.line.toLowerCase().includes('error');
          if (passed || failed) {
            setSteps(prev => prev.map(s =>
              s.id === name && s.status === 'active'
                ? { ...s, status: passed ? 'done' : 'failed' }
                : s
            ));
            if (failed) play('error');
          }
        }
      }
    }
    if (e.type === 'done') {
      // Finalise any remaining active/pending steps
      setSteps(prev => prev.map(s =>
        s.status === 'active' ? { ...s, status: e.ok ? 'done' : 'failed' } : s
      ));
      setProgress(100);
      setStatusMsg(e.ok ? 'Complete.' : 'Finished with errors.');
      play(e.ok ? 'success' : 'error');
      setTimeout(onDone, 1500);
    }
    if (e.type === 'error') {
      setStatusMsg('Error: ' + e.message);
      play('error');
    }
  }

  function runTests() {
    play('click');
    setSteps(TEST_NAMES.map(n => ({ id: n, label: n, status: 'pending', detail: TEST_DESCRIPTIONS[n] })));
    setProgress(0);
    setStatusMsg('Starting resilience tests…');
    const { url, body } = actionRunResilienceTests(service);
    sse.start(url, body, handleEvent);
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      {/* Progress bar */}
      <div style={{ marginBottom: 14 }}>
        <div className="progress-bar" style={{ marginBottom: 8 }}>
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>{statusMsg || 'Ready'}</span>
          <span>{progress}%</span>
        </div>
      </div>

      {/* Step list */}
      <StepList steps={steps} />

      {/* SSE log output */}
      {(sse.running || sse.lines.length > 0 || sse.connectError) && (
        <div style={{
          marginTop: 12,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '10px 12px',
          maxHeight: 180,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.6,
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
              {sse.succeeded ? '✓ All tests complete.' : '✗ Tests finished with errors.'}
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      )}

      {/* Action row */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={sse.running}
          onClick={runTests}
        >
          {sse.running ? <><Spinner size={12} color="#fff" /> Running…</> : '▶ Run All Tests'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Runs against <strong>{service}</strong> in the cluster
        </span>
        {sse.finished && (
          <button
            className="btn btn-secondary"
            onClick={() => { sse.reset(); setProgress(0); setStatusMsg(''); setSteps(TEST_NAMES.map(n => ({ id: n, label: n, status: 'pending', detail: TEST_DESCRIPTIONS[n] }))); }}
            style={{ fontSize: 12 }}
          >
            ↺ Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main section ───────────────────────────────────────────────────────────────

export function ResilienceSection() {
  const { play } = useSound();
  const { data: names } = useFetch(fetchServiceNames);
  const { data, loading, error, refresh } = useFetch(fetchAllResilienceResults);
  const [selectedService, setSelectedService] = useState('');
  const [showLiveRun, setShowLiveRun] = useState(false);

  const allServices = names || (data ? Object.keys(data) : []);
  const displayService = selectedService || allServices[0] || '';
  const runsForService: ResilienceRun[] = data?.[displayService] || [];

  if (loading) {
    return (
      <div>
        <h1 className="section-title">Resilience Tests</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <Spinner /> Loading results…
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>Resilience Tests</h1>
        <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { play('click'); refresh(); }}>
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>Could not load results: {error}</div>
        </div>
      )}

      {/* What each test does */}
      <div className="card" style={{ marginBottom: 18, padding: 0 }}>
        {TEST_NAMES.map((name, i) => (
          <div key={name} style={{
            display: 'flex',
            gap: 12,
            padding: '10px 14px',
            borderBottom: i < TEST_NAMES.length - 1 ? '1px solid var(--border)' : 'none',
            alignItems: 'flex-start',
          }}>
            <span style={{
              width: 22, height: 22,
              borderRadius: '50%',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, flexShrink: 0,
            }}>{i + 1}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{TEST_DESCRIPTIONS[name]}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Service selector */}
      {allServices.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {allServices.map(svc => (
            <button
              key={svc}
              onClick={() => { play('click'); setSelectedService(svc); setShowLiveRun(false); }}
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
          {/* Live run panel */}
          {showLiveRun ? (
            <LiveRunPanel
              service={displayService}
              onDone={() => { setShowLiveRun(false); refresh(); }}
            />
          ) : (
            <div style={{ marginBottom: 18 }}>
              <button
                className="btn btn-primary"
                onClick={() => { play('click'); setShowLiveRun(true); }}
                disabled={!displayService}
              >
                ▶ Run All Tests
              </button>
              <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                against <strong>{displayService}</strong>
              </span>
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                (triggers <code style={{ fontFamily: 'monospace', fontSize: 11 }}>./run-resilience-tests.sh</code> on cluster)
              </span>
            </div>
          )}

          {/* Results history */}
          <div style={{ marginBottom: 10 }}>
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: 10,
            }}>
              Recent runs — {displayService}
            </div>
            {runsForService.length === 0 ? (
              <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                No recorded runs yet. Click "Run All Tests" above to start.
              </div>
            ) : (
              runsForService.slice(0, 10).map(run => (
                <ResultCard key={run.id} run={run} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
