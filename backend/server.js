// Platform Dashboard — Backend API
// Reads live cluster state via kubectl. Never writes secrets.
'use strict';

const express = require('express');
const cors    = require('cors');
const cluster = require('./cluster');
const kc      = require('./kubectl');
const actions = require('./actions');

const PORT    = parseInt(process.env.PORT || '3001', 10);
const APPS_NS = process.env.APPS_NS || 'apps';

const app = express();
app.use(cors());
app.use(express.json());

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Cluster Status ────────────────────────────────────────────────────────────
app.get('/api/status', async (_req, res) => {
  try {
    const status = await cluster.getClusterStatus();
    res.json(status);
  } catch (err) {
    console.error('/api/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Services ──────────────────────────────────────────────────────────────────
app.get('/api/services', async (_req, res) => {
  try {
    const services = await cluster.getServices();
    res.json(services);
  } catch (err) {
    console.error('/api/services error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services/names', async (_req, res) => {
  try {
    const names = await cluster.getServiceNames();
    res.json(names);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', async (req, res) => {
  const service = req.params.service;
  const lines   = Math.min(parseInt(req.query.lines || '100', 10), 1000);

  try {
    // Find pods for this deployment
    const podList = await kc.listJson('pods', APPS_NS);
    const pods    = (podList.items || []).filter(p =>
      p.metadata?.labels?.app === service &&
      p.status?.phase === 'Running'
    );

    if (pods.length === 0) {
      return res.json([]);
    }

    // Pick the first ready pod
    const pod      = pods[0];
    const podName  = pod.metadata.name;
    const rawLogs  = await kc.podLogs(podName, APPS_NS, lines);

    // Parse lines into structured entries
    const entries = rawLogs.split('\n').filter(Boolean).map((line, i) => {
      // Try to parse JSON logs (common with structured logging)
      try {
        const obj = JSON.parse(line);
        return {
          timestamp: obj.time || obj.timestamp || obj.ts || new Date().toISOString(),
          level:     (obj.level || obj.severity || 'info').toLowerCase(),
          pod:       podName,
          message:   obj.msg || obj.message || line,
        };
      } catch {
        // Plain text log line — try to detect level from content
        const lower = line.toLowerCase();
        const level = lower.includes('error') ? 'error'
                    : lower.includes('warn')  ? 'warn'
                    : lower.includes('debug') ? 'debug'
                    : 'info';
        return {
          timestamp: new Date().toISOString(),
          level,
          pod:       podName,
          message:   line,
        };
      }
    });

    res.json(entries);
  } catch (err) {
    console.error(`/api/logs/${service} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Migrations ────────────────────────────────────────────────────────────────
// Migration history is stored in ConfigMap <service>-migration-history
// key format: <MIGRATION_ID>-<phase> → "<timestamp>|<status>|<notes>"

function parseMigrationCm(service, data) {
  const runs = [];
  for (const [key, value] of Object.entries(data)) {
    // key: <id>-<phase>
    const lastDash = key.lastIndexOf('-');
    if (lastDash === -1) continue;
    const id    = key.slice(0, lastDash);
    const phase = key.slice(lastDash + 1);
    const [timestamp, status, ...notesParts] = value.split('|');
    runs.push({
      id,
      service,
      phase,
      status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'running',
      timestamp: timestamp || new Date().toISOString(),
      notes: notesParts.join('|') || undefined,
    });
  }
  // Newest first
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs;
}

app.get('/api/migrations', async (_req, res) => {
  try {
    const names  = await cluster.getServiceNames();
    const result = {};
    await Promise.all(names.map(async (svc) => {
      const data = await kc.getConfigMapData(`${svc}-migration-history`, APPS_NS);
      result[svc] = parseMigrationCm(svc, data);
    }));
    res.json(result);
  } catch (err) {
    console.error('/api/migrations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/migrations/:service', async (req, res) => {
  const svc = req.params.service;
  try {
    const data = await kc.getConfigMapData(`${svc}-migration-history`, APPS_NS);
    res.json(parseMigrationCm(svc, data));
  } catch (err) {
    console.error(`/api/migrations/${svc} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Resilience Results ────────────────────────────────────────────────────────
// Stored in ConfigMap <service>-resilience-results
// key: <RUN_ID> → JSON string of run object

function parseResilienceCm(service, data) {
  const runs = [];
  for (const [, value] of Object.entries(data)) {
    try {
      const run = JSON.parse(value);
      runs.push(run);
    } catch {
      // Skip malformed entries
    }
  }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, 10); // Last 10 runs
}

app.get('/api/resilience', async (_req, res) => {
  try {
    const names  = await cluster.getServiceNames();
    const result = {};
    await Promise.all(names.map(async (svc) => {
      const data = await kc.getConfigMapData(`${svc}-resilience-results`, APPS_NS);
      result[svc] = parseResilienceCm(svc, data);
    }));
    res.json(result);
  } catch (err) {
    console.error('/api/resilience error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resilience/:service', async (req, res) => {
  const svc = req.params.service;
  try {
    const data = await kc.getConfigMapData(`${svc}-resilience-results`, APPS_NS);
    res.json(parseResilienceCm(svc, data));
  } catch (err) {
    console.error(`/api/resilience/${svc} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Action Routes (SSE) ───────────────────────────────────────────────────────
// All POST routes below stream output via Server-Sent Events.
// The browser connects, receives a stream of JSON lines, and the connection
// closes when the script finishes.
//
// Event format:
//   data: {"type":"log","line":"..."}        — stdout/stderr line
//   data: {"type":"progress","step":"...","pct":40}  — optional progress hint
//   data: {"type":"done","ok":true}          — script exited 0
//   data: {"type":"done","ok":false,"exitCode":1}    — script failed
//   data: {"type":"error","message":"..."}   — spawn error
//
// IMPORTANT: secret values are NEVER accepted by these routes.
// Secrets travel exclusively in-memory inside shell scripts via:
//   kubectl create secret --dry-run=client -o yaml | kubectl apply -f -

// Setup — install cluster components
app.post('/api/setup/argocd',        actions.setupArgocd);
app.post('/api/setup/keda',          actions.setupKeda);
app.post('/api/setup/observability', actions.setupObservability);

// Service lifecycle
app.post('/api/onboard',                       actions.onboardService);
app.post('/api/build/:service',                actions.buildService);
app.post('/api/deploy/:service',               actions.deployService);
app.post('/api/gitops/:service',               actions.registerGitops);
app.post('/api/autoscaling/:service',          actions.configureAutoscaling);
app.post('/api/monitoring/:service',           actions.configureMonitoring);
app.post('/api/services/:service/restart',     actions.restartService);
app.post('/api/secrets/:service/rotate',       actions.rotateSecret);

// Migrations — expand-contract pattern
app.post('/api/migrate/:service',              actions.runMigration);

// Resilience tests
app.post('/api/resilience/:service/run',       actions.runResilienceTests);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Platform Dashboard backend listening on :${PORT}`);
  console.log(`  APPS_NS:     ${APPS_NS}`);
  console.log(`  KUBECONFIG:  ${process.env.KUBECONFIG || '(default)'}`);
});
