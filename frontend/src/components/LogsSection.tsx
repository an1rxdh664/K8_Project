'use client';

import { useState, useCallback } from 'react';
import { useFetch } from '@/hooks/useFetch';
import { fetchLogs, fetchServiceNames } from '@/lib/api';
import { Spinner } from './Spinner';
import { useSound } from '@/hooks/useSound';
import type { LogEntry } from '@/types';

const LEVEL_COLOR: Record<string, string> = {
  error: 'var(--danger)',
  warn:  'var(--accent)',
  info:  'var(--text-muted)',
  debug: 'var(--border-strong)',
};

const LEVEL_BG: Record<string, string> = {
  error: 'color-mix(in srgb, var(--danger) 12%, transparent)',
  warn:  'color-mix(in srgb, var(--accent) 10%, transparent)',
  info:  'transparent',
  debug: 'transparent',
};

function LogLine({ entry }: { entry: LogEntry }) {
  const color = LEVEL_COLOR[entry.level] || 'var(--text-muted)';
  const bg    = LEVEL_BG[entry.level]    || 'transparent';
  const ts    = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false });

  return (
    <div style={{
      display: 'flex',
      gap: 10,
      padding: '3px 8px',
      borderRadius: 4,
      background: bg,
      alignItems: 'flex-start',
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0, userSelect: 'none' }}>{ts}</span>
      <span style={{
        color,
        fontWeight: 600,
        width: 36,
        flexShrink: 0,
        textTransform: 'uppercase',
        fontSize: 10,
        paddingTop: 2,
      }}>{entry.level}</span>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 10, paddingTop: 2 }}>
        [{entry.pod}]
      </span>
      <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{entry.message}</span>
    </div>
  );
}

function LevelFilter({
  level,
  active,
  count,
  onClick,
}: {
  level: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  const color = LEVEL_COLOR[level] || 'var(--text-muted)';
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        border: `1px solid ${active ? color : 'var(--border)'}`,
        background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
        color: active ? color : 'var(--text-muted)',
        transition: 'all 150ms ease',
      }}
    >
      {level} <span style={{ opacity: 0.7 }}>{count}</span>
    </button>
  );
}

export function LogsSection() {
  const { play } = useSound();

  // Service selector
  const { data: names, loading: loadingNames } = useFetch(fetchServiceNames);
  const [selectedService, setSelectedService] = useState<string>('');
  const [lines, setLines] = useState(100);
  const [levelFilters, setLevelFilters] = useState<Set<string>>(new Set(['error', 'warn', 'info', 'debug']));

  const fetcher = useCallback(
    () => selectedService ? fetchLogs(selectedService, lines) : Promise.resolve([]),
    [selectedService, lines]
  );
  const { data: logs, loading: loadingLogs, error, refresh } = useFetch<LogEntry[]>(fetcher, [selectedService, lines]);

  function toggleLevel(level: string) {
    play('click');
    setLevelFilters(prev => {
      const next = new Set(prev);
      next.has(level) ? next.delete(level) : next.add(level);
      return next;
    });
  }

  function handleServiceChange(svc: string) {
    play('click');
    setSelectedService(svc);
  }

  const displayedLogs = (logs || []).filter(e => levelFilters.has(e.level));
  const counts: Record<string, number> = {};
  for (const e of logs || []) counts[e.level] = (counts[e.level] || 0) + 1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>Logs</h1>
        {selectedService && (
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { play('click'); refresh(); }}>
            ↻ Refresh
          </button>
        )}
      </div>

      {/* Controls row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Service picker */}
        <div style={{ position: 'relative' }}>
          <select
            value={selectedService}
            onChange={e => handleServiceChange(e.target.value)}
            disabled={loadingNames}
            style={{
              padding: '6px 28px 6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
              appearance: 'none',
              minWidth: 160,
            }}
          >
            <option value="">Select service…</option>
            {(names || []).map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 10,
          }}>▾</span>
        </div>

        {/* Lines picker */}
        <div style={{ position: 'relative' }}>
          <select
            value={lines}
            onChange={e => { play('click'); setLines(Number(e.target.value)); }}
            style={{
              padding: '6px 28px 6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elevated)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
              appearance: 'none',
            }}
          >
            {[50, 100, 200, 500].map(n => (
              <option key={n} value={n}>Last {n} lines</option>
            ))}
          </select>
          <span style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 10,
          }}>▾</span>
        </div>

        {/* Level filters */}
        {logs && logs.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {['error', 'warn', 'info', 'debug'].map(lvl => (
              <LevelFilter
                key={lvl}
                level={lvl}
                active={levelFilters.has(lvl)}
                count={counts[lvl] || 0}
                onClick={() => toggleLevel(lvl)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Log output */}
      {!selectedService ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Select a service above to view its pod logs.
        </div>
      ) : loadingLogs ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <Spinner /> Fetching logs…
        </div>
      ) : error ? (
        <div className="card">
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 4 }}>Could not fetch logs</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{error}</div>
        </div>
      ) : displayedLogs.length === 0 ? (
        <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {logs && logs.length > 0 ? 'All lines hidden by filters.' : 'No logs found — pod may not be running.'}
        </div>
      ) : (
        <div style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '10px 4px',
          maxHeight: 480,
          overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 8px 6px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {displayedLogs.length} line{displayedLogs.length !== 1 ? 's' : ''}
            </span>
          </div>
          {displayedLogs.map((entry, i) => (
            <LogLine key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
