'use client';

import { useEffect, useRef, useState } from 'react';
import { useSSE } from '@/hooks/useSSE';
import { useSound } from '@/hooks/useSound';
import {
  actionSetupArgocd,
  actionSetupKeda,
  actionSetupObservability,
} from '@/lib/actions';
import { useFetch } from '@/hooks/useFetch';
import { fetchClusterStatus } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

type ComponentStatus = 'running' | 'degraded' | 'unknown' | 'installing';

interface ComponentCardProps {
  title: string;
  description: string;
  status: ComponentStatus;
  version?: string;
  externalUrl?: string;
  onInstall: () => void;
  installing: boolean;
  logLines: string[];
  finished: boolean;
  succeeded: boolean | null;
  disabled: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: ComponentStatus }) {
  const color =
    status === 'running'    ? 'var(--success)'
    : status === 'installing' ? 'var(--accent)'
    : status === 'degraded'  ? 'var(--danger)'
    : 'var(--text-muted)';

  const isSpinning = status === 'installing';

  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
      animation: isSpinning ? 'pulse 1.4s ease-in-out infinite' : 'none',
    }} />
  );
}

function statusLabel(s: ComponentStatus) {
  if (s === 'running')    return 'Running';
  if (s === 'installing') return 'Installing…';
  if (s === 'degraded')   return 'Degraded';
  return 'Not installed';
}

// ── Log stream panel ──────────────────────────────────────────────────────────

function LogPanel({ lines, finished, succeeded }: {
  lines: string[];
  finished: boolean;
  succeeded: boolean | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  if (lines.length === 0 && !finished) return null;

  return (
    <div style={{
      marginTop: 12,
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      {/* Header bar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        color: 'var(--text-muted)',
        background: 'var(--bg-elevated)',
      }}>
        <span>Output</span>
        {finished && (
          <span style={{
            marginLeft: 'auto',
            color: succeeded ? 'var(--success)' : 'var(--danger)',
            fontWeight: 600,
          }}>
            {succeeded ? '✓ Done' : '✗ Failed'}
          </span>
        )}
      </div>

      {/* Log lines */}
      <div style={{
        maxHeight: 260,
        overflowY: 'auto',
        padding: '10px 12px',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--text)',
      }}>
        {lines.map((line, i) => {
          const lower = line.toLowerCase();
          const color =
            lower.includes('error') || lower.includes('fatal')   ? 'var(--danger)'
            : lower.includes('warn')                             ? '#B8860B'
            : lower.includes('✓') || lower.includes('success')  ? 'var(--success)'
            : 'inherit';
          return (
            <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {line.replace(/\n$/, '')}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Component card ────────────────────────────────────────────────────────────

function ComponentCard({
  title,
  description,
  status,
  version,
  externalUrl,
  onInstall,
  installing,
  logLines,
  finished,
  succeeded,
  disabled,
}: ComponentCardProps) {
  const isInstalled = status === 'running' || status === 'degraded';

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '20px 22px',
      transition: 'border-color 150ms ease',
    }}
    onMouseEnter={(e) => {
      (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)';
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
    }}
    >
      {/* Card header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
            {version && (
              <span style={{
                fontSize: 10, color: 'var(--text-muted)',
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 5px',
              }}>{version}</span>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            {description}
          </p>
        </div>

        {/* Status badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 20,
          border: '1px solid var(--border)',
          background: 'var(--bg)',
          fontSize: 11, color: 'var(--text-muted)', flexShrink: 0,
        }}>
          <StatusDot status={installing ? 'installing' : status} />
          {installing ? 'Installing…' : statusLabel(status)}
        </div>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <button
          onClick={onInstall}
          disabled={disabled || installing}
          style={{
            padding: '7px 16px',
            borderRadius: 6,
            border: 'none',
            background: isInstalled && !installing ? 'var(--bg)' : 'var(--accent)',
            color: isInstalled && !installing ? 'var(--text)' : '#fff',
            border: isInstalled && !installing ? '1px solid var(--border)' : 'none',
            fontSize: 12, fontWeight: 500,
            cursor: disabled || installing ? 'not-allowed' : 'pointer',
            opacity: disabled || installing ? 0.5 : 1,
            transition: 'opacity 150ms, transform 150ms',
            transform: 'scale(1)',
          } as React.CSSProperties}
          onMouseDown={(e) => {
            if (!disabled && !installing) {
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.97)';
            }
          }}
          onMouseUp={(e) => {
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
          }}
        >
          {installing ? 'Installing…' : isInstalled ? 'Re-install' : 'Install'}
        </button>

        {externalUrl && status === 'running' && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12, color: 'var(--accent)',
              textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            Open UI ↗
          </a>
        )}
      </div>

      {/* Log stream */}
      <LogPanel lines={logLines} finished={finished} succeeded={succeeded} />
    </div>
  );
}

// ── SetupSection ──────────────────────────────────────────────────────────────

export function SetupSection() {
  const { play } = useSound();

  // Cluster status for current component states
  const { data: clusterStatus, refresh: refreshStatus } = useFetch(fetchClusterStatus, []);

  // Three independent SSE streams — one per component
  const argoCdSSE   = useSSE();
  const kedaSSE     = useSSE();
  const prometheusSSE = useSSE();

  // Which component is currently installing (only one at a time)
  const anyInstalling = argoCdSSE.running || kedaSSE.running || prometheusSSE.running;

  function install(
    sse: ReturnType<typeof useSSE>,
    action: { url: string; body?: Record<string, unknown> },
  ) {
    play('click');
    sse.reset();
    sse.start(action.url, action.body, (e) => {
      if (e.type === 'done') {
        play(e.ok ? 'success' : 'error');
        // Refresh cluster status after a short delay so badges update
        setTimeout(refreshStatus, 2000);
      }
    });
  }

  return (
    <section>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', margin: '0 0 6px' }}>
          Setup
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Install cluster-wide components. Run these once after the cluster is created.
          Installation streams live output below each card.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ArgoCD */}
        <ComponentCard
          title="ArgoCD"
          description="GitOps continuous delivery. Syncs your services from Git repositories to the cluster. Uses ignoreDifferences on spec.replicas to avoid conflicts with KEDA."
          status={clusterStatus?.argoCDStatus ?? 'unknown'}
          onInstall={() => install(argoCdSSE, actionSetupArgocd())}
          installing={argoCdSSE.running}
          logLines={argoCdSSE.lines}
          finished={argoCdSSE.finished}
          succeeded={argoCdSSE.succeeded}
          disabled={anyInstalling && !argoCdSSE.running}
          externalUrl="http://localhost:8080"
        />

        {/* KEDA */}
        <ComponentCard
          title="KEDA"
          description="Kubernetes Event-Driven Autoscaling. Scales your deployments based on custom metrics — HTTP requests, queue depth, CPU, and more."
          status={clusterStatus?.kedaStatus ?? 'unknown'}
          onInstall={() => install(kedaSSE, actionSetupKeda())}
          installing={kedaSSE.running}
          logLines={kedaSSE.lines}
          finished={kedaSSE.finished}
          succeeded={kedaSSE.succeeded}
          disabled={anyInstalling && !kedaSSE.running}
        />

        {/* Prometheus + Grafana */}
        <ComponentCard
          title="Prometheus + Grafana"
          description="kube-prometheus-stack: metrics collection, alerting rules, and pre-built Kubernetes dashboards. Services get a ServiceMonitor automatically on onboard."
          status={clusterStatus?.prometheusStatus ?? 'unknown'}
          onInstall={() => install(prometheusSSE, actionSetupObservability())}
          installing={prometheusSSE.running}
          logLines={prometheusSSE.lines}
          finished={prometheusSSE.finished}
          succeeded={prometheusSSE.succeeded}
          disabled={anyInstalling && !prometheusSSE.running}
          externalUrl="http://localhost:3000"
        />
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </section>
  );
}
