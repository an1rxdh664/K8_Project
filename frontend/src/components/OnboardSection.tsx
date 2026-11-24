'use client';

import { useRef, useState } from 'react';
import { useSSE } from '@/hooks/useSSE';
import { useSound } from '@/hooks/useSound';
import { actionOnboard } from '@/lib/actions';
import type { OnboardForm } from '@/types';

// ── Shared input style helpers ────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
  transition: 'border-color 150ms',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: 5,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  marginTop: 4,
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}

function InputField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{ ...inputStyle, opacity: disabled ? 0.5 : 1 }}
        onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
        onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
      />
    </Field>
  );
}

function SelectField({
  label,
  hint,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          ...inputStyle,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
        onFocus={(e) => { (e.target as HTMLSelectElement).style.borderColor = 'var(--accent)'; }}
        onBlur={(e)  => { (e.target as HTMLSelectElement).style.borderColor = 'var(--border)'; }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

// ── Repeatable key=value rows ─────────────────────────────────────────────────

function EnvVarRows({
  rows,
  onChange,
  disabled,
}: {
  rows: { key: string; value: string }[];
  onChange: (rows: { key: string; value: string }[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, field: 'key' | 'value', v: string) {
    const next = rows.map((r, idx) => idx === i ? { ...r, [field]: v } : r);
    onChange(next);
  }
  function add() { onChange([...rows, { key: '', value: '' }]); }
  function remove(i: number) { onChange(rows.filter((_, idx) => idx !== i)); }

  return (
    <Field
      label="Environment Variables"
      hint="Plain text values only. Secret values go in Secret Names below."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="KEY"
              value={row.key}
              onChange={(e) => update(i, 'key', e.target.value)}
              disabled={disabled}
              style={{ ...inputStyle, flex: '0 0 38%', fontFamily: 'monospace', fontSize: 12 }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
              onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
            />
            <input
              type="text"
              placeholder="value"
              value={row.value}
              onChange={(e) => update(i, 'value', e.target.value)}
              disabled={disabled}
              style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
              onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
            />
            <button
              onClick={() => remove(i)}
              disabled={disabled}
              style={{
                width: 28, height: 28, borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg)',
                color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
              title="Remove"
            >×</button>
          </div>
        ))}
        <button
          onClick={add}
          disabled={disabled}
          style={{
            padding: '6px 12px', borderRadius: 6,
            border: '1px dashed var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 12, alignSelf: 'flex-start',
          }}
        >
          + Add variable
        </button>
      </div>
    </Field>
  );
}

// ── Secret name rows ──────────────────────────────────────────────────────────

function SecretNameRows({
  names,
  onChange,
  disabled,
}: {
  names: string[];
  onChange: (names: string[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, v: string) {
    onChange(names.map((n, idx) => idx === i ? v : n));
  }
  function add()         { onChange([...names, '']); }
  function remove(i: number) { onChange(names.filter((_, idx) => idx !== i)); }

  return (
    <Field
      label="Secret Names"
      hint="Names of Kubernetes secrets this service needs. Values are never entered here — the shell script prompts for them securely in-memory."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {names.map((name, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="my-db-password"
              value={name}
              onChange={(e) => update(i, e.target.value)}
              disabled={disabled}
              style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
              onBlur={(e)  => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)'; }}
            />
            <button
              onClick={() => remove(i)}
              disabled={disabled}
              style={{
                width: 28, height: 28, borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg)',
                color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
              title="Remove"
            >×</button>
          </div>
        ))}
        <button
          onClick={add}
          disabled={disabled}
          style={{
            padding: '6px 12px', borderRadius: 6,
            border: '1px dashed var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 12, alignSelf: 'flex-start',
          }}
        >
          + Add secret name
        </button>
      </div>
    </Field>
  );
}

// ── Log panel (reused from SetupSection style) ────────────────────────────────

function LogPanel({ lines, finished, succeeded }: {
  lines: string[];
  finished: boolean;
  succeeded: boolean | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  if (lines.length === 0 && !finished) return null;

  return (
    <div style={{
      marginTop: 24,
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '6px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--text-muted)',
        background: 'var(--bg-elevated)',
      }}>
        <span>Onboard output</span>
        {finished && (
          <span style={{
            marginLeft: 'auto',
            color: succeeded ? 'var(--success)' : 'var(--danger)',
            fontWeight: 600,
          }}>
            {succeeded ? '✓ Done — service onboarded' : '✗ Onboard failed'}
          </span>
        )}
      </div>
      <div style={{
        maxHeight: 320, overflowY: 'auto',
        padding: '12px 14px',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12, lineHeight: 1.6, color: 'var(--text)',
      }}>
        {lines.map((line, i) => {
          const lower = line.toLowerCase();
          const color =
            lower.includes('error') || lower.includes('fatal') ? 'var(--danger)'
            : lower.includes('warn')                           ? '#B8860B'
            : lower.includes('✓') || lower.includes('success')? 'var(--success)'
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

// ── Validation ────────────────────────────────────────────────────────────────

function validate(form: OnboardForm): string | null {
  if (!form.repoUrl.trim())     return 'Repository URL is required.';
  if (!form.branch.trim())      return 'Branch is required.';
  if (!form.serviceName.trim()) return 'Service name is required.';
  if (!/^[a-z0-9-]+$/.test(form.serviceName.trim())) {
    return 'Service name must be lowercase alphanumeric with hyphens only.';
  }
  const port = parseInt(form.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) return 'Port must be 1–65535.';
  const reps = parseInt(form.replicas, 10);
  if (isNaN(reps) || reps < 1) return 'Replicas must be ≥ 1.';
  for (const ev of form.envVars) {
    if (!ev.key.trim()) return 'All env var keys must be filled in.';
  }
  for (const sn of form.secretNames) {
    if (!sn.trim()) return 'All secret name fields must be filled in.';
  }
  return null;
}

// ── Default form ──────────────────────────────────────────────────────────────

const DEFAULT_FORM: OnboardForm = {
  repoUrl: '',
  branch: '',
  serviceName: '',
  buildMethod: 'auto',
  dbMode: 'none',
  port: '8080',
  replicas: '1',
  envVars: [],
  secretNames: [],
};

// ── OnboardSection ────────────────────────────────────────────────────────────

export function OnboardSection() {
  const { play } = useSound();
  const sse = useSSE();
  const [form, setForm] = useState<OnboardForm>(DEFAULT_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  function set<K extends keyof OnboardForm>(key: K, value: OnboardForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit() {
    const err = validate(form);
    if (err) {
      setValidationError(err);
      play('error');
      return;
    }
    setValidationError(null);
    play('click');

    const { url, body } = actionOnboard({
      repoUrl:     form.repoUrl.trim(),
      branch:      form.branch.trim(),
      serviceName: form.serviceName.trim(),
      buildMethod: form.buildMethod,
      dbMode:      form.dbMode,
      port:        parseInt(form.port, 10),
      replicas:    parseInt(form.replicas, 10),
      envVars:     form.envVars.filter(e => e.key.trim()),
      secretNames: form.secretNames.filter(s => s.trim()),
    });

    sse.reset();
    sse.start(url, body, (e) => {
      if (e.type === 'done') {
        play(e.ok ? 'success' : 'error');
        if (e.ok) {
          // Reset form on success
          setTimeout(() => setForm(DEFAULT_FORM), 1500);
        }
      }
    });
  }

  const disabled = sse.running;

  return (
    <section>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', margin: '0 0 6px' }}>
          Onboard Service
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          Register a new service with the platform. Clones the repo, builds the image,
          generates Kubernetes manifests, and registers with ArgoCD.
        </p>
      </div>

      {/* Form card */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '24px 26px',
      }}>

        {/* Row 1: Repo + Branch */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 14, marginBottom: 18 }}>
          <InputField
            label="Repository URL *"
            placeholder="https://github.com/org/repo"
            value={form.repoUrl}
            onChange={(v) => set('repoUrl', v)}
            disabled={disabled}
          />
          <InputField
            label="Branch *"
            placeholder="main"
            value={form.branch}
            onChange={(v) => set('branch', v)}
            disabled={disabled}
          />
        </div>

        {/* Row 2: Service name */}
        <div style={{ marginBottom: 18 }}>
          <InputField
            label="Service Name *"
            placeholder="my-service"
            hint="Lowercase letters, numbers, and hyphens only. Used as the deployment name."
            value={form.serviceName}
            onChange={(v) => set('serviceName', v)}
            disabled={disabled}
          />
        </div>

        {/* Row 3: Build method + DB mode */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
          <SelectField
            label="Build Method"
            hint="auto = tries Buildpacks first, falls back to Dockerfile"
            value={form.buildMethod}
            onChange={(v) => set('buildMethod', v as OnboardForm['buildMethod'])}
            disabled={disabled}
            options={[
              { value: 'auto',        label: 'Auto (Buildpacks → Dockerfile)' },
              { value: 'buildpacks',  label: 'Cloud Native Buildpacks (Paketo)' },
              { value: 'dockerfile',  label: 'Dockerfile' },
            ]}
          />
          <SelectField
            label="Database Mode"
            hint="isolated = dedicated DB; shared = shared schema"
            value={form.dbMode}
            onChange={(v) => set('dbMode', v as OnboardForm['dbMode'])}
            disabled={disabled}
            options={[
              { value: 'none',     label: 'None' },
              { value: 'isolated', label: 'Isolated (own DB)' },
              { value: 'shared',   label: 'Shared schema' },
            ]}
          />
        </div>

        {/* Row 4: Port + Replicas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
          <InputField
            label="Container Port"
            type="number"
            placeholder="8080"
            value={form.port}
            onChange={(v) => set('port', v)}
            disabled={disabled}
          />
          <InputField
            label="Initial Replicas"
            type="number"
            placeholder="1"
            value={form.replicas}
            onChange={(v) => set('replicas', v)}
            disabled={disabled}
          />
        </div>

        {/* Env vars */}
        <div style={{ marginBottom: 24 }}>
          <EnvVarRows
            rows={form.envVars}
            onChange={(rows) => set('envVars', rows)}
            disabled={disabled}
          />
        </div>

        {/* Secret names */}
        <div style={{ marginBottom: 28 }}>
          <SecretNameRows
            names={form.secretNames}
            onChange={(names) => set('secretNames', names)}
            disabled={disabled}
          />
        </div>

        {/* Validation error */}
        {validationError && (
          <div style={{
            padding: '10px 14px',
            borderRadius: 6,
            background: 'rgba(179,71,60,0.08)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            fontSize: 12,
            marginBottom: 18,
          }}>
            {validationError}
          </div>
        )}

        {/* Submit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={handleSubmit}
            disabled={disabled}
            style={{
              padding: '9px 22px',
              borderRadius: 6,
              border: 'none',
              background: disabled ? 'var(--accent)' : 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'opacity 150ms, transform 150ms',
              transform: 'scale(1)',
            }}
            onMouseDown={(e) => {
              if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.97)';
            }}
            onMouseUp={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
            }}
          >
            {disabled ? 'Onboarding…' : 'Onboard Service'}
          </button>

          {sse.connectError && (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
              {sse.connectError}
            </span>
          )}
        </div>
      </div>

      {/* Live output */}
      <LogPanel
        lines={sse.lines}
        finished={sse.finished}
        succeeded={sse.succeeded}
      />
    </section>
  );
}
