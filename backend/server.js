// Platform Dashboard — Backend API  (fixed version)
// Reads live cluster state via kubectl. Never writes secrets.
//
// Changes vs original (search for "FIX"):
//  1. Logs: pods are labelled app.kubernetes.io/name (by generate-manifests.sh), not "app".
//  2. Migrations: run-migration.sh stores "succeeded"/"timeout"; the API only knew "success".
//  3. Resilience: run-resilience-tests.sh stores {run_id, tests:{name:"pass"}, passed, failed};
//     the frontend type expects {id, overallStatus, tests:[{name,status,...}]} and crashed on .map().
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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', async (_req, res) => {
  try { res.json(await cluster.getClusterStatus()); }
  catch (err) { console.error('/api/status error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/services', async (_req, res) => {
  try { res.json(await cluster.getServices()); }
  catch (err) { console.error('/api/services error:', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/services/names', async (_req, res) => {
  try { res.json(await cluster.getServiceNames()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Logs ─────────────────────────────────────────────────────────────────────
app.get('/api/logs/:service', async (req, res) => {
  const service = req.params.service;
  const lines   = Math.min(parseInt(req.query.lines || '100', 10), 1000);

  try {
    const podList = await kc.listJson('pods', APPS_NS);
    // FIX 1: label key used by generate-manifests.sh
    const pods = (podList.items || []).filter(p =>
      p.metadata?.labels?.['app.kubernetes.io/name'] === service &&
      p.status?.phase === 'Running'
    );
    if (pods.length === 0) return res.json([]);

    const podName = pods[0].metadata.name;
    const rawLogs = await kc.podLogs(podName, APPS_NS, lines);

    const entries = rawLogs.split('\n').filter(Boolean).map((line) => {
      try {
        const obj = JSON.parse(line);
        return {
          timestamp: obj.time || obj.timestamp || obj.ts || new Date().toISOString(),
          level:     String(obj.level || obj.severity || 'info').toLowerCase(),
          pod:       podName,
          message:   obj.msg || obj.message || line,
        };
      } catch {
        const lower = line.toLowerCase();
        const level = lower.includes('error') ? 'error'
                    : lower.includes('warn')  ? 'warn'
                    : lower.includes('debug') ? 'debug'
                    : 'info';
        return { timestamp: new Date().toISOString(), level, pod: podName, message: line };
      }
    });
    res.json(entries);
  } catch (err) {
    console.error(`/api/logs/${service} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Migrations ───────────────────────────────────────────────────────────────
// ConfigMap <service>-migration-history, key "<MIGRATION_ID>-<phase>" -> "<ts>|<status>|<notes>"
function parseMigrationCm(service, data) {
  const runs = [];
  for (const [key, value] of Object.entries(data)) {
    const lastDash = key.lastIndexOf('-');
    if (lastDash === -1) continue;
    const id    = key.slice(0, lastDash);
    const phase = key.slice(lastDash + 1);
    const [timestamp, status, ...notesParts] = value.split('|');
    // FIX 2: the script writes succeeded | failed | timeout
    const mapped = (status === 'succeeded' || status === 'success') ? 'success'
                 : (status === 'failed' || status === 'timeout')    ? 'failed'
                 : 'running';
    runs.push({
      id, service, phase,
      status: mapped,
      timestamp: timestamp || new Date().toISOString(),
      notes: notesParts.join('|') || undefined,
    });
  }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs;
}

app.get('/api/migrations', async (_req, res) => {
  try {
    const names  = await cluster.getServiceNames();
    const result = {};
    await Promise.all(names.map(async (svc) => {
      result[svc] = parseMigrationCm(svc, await kc.getConfigMapData(`${svc}-migration-history`, APPS_NS));
    }));
    res.json(result);
  } catch (err) {
    console.error('/api/migrations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/migrations/:service', async (req, res) => {
  const svc = req.params.service;
  try { res.json(parseMigrationCm(svc, await kc.getConfigMapData(`${svc}-migration-history`, APPS_NS))); }
  catch (err) { console.error(`/api/migrations/${svc} error:`, err.message); res.status(500).json({ error: err.message }); }
});

// ── Resilience results ───────────────────────────────────────────────────────
// FIX 3: convert the script's JSON into the shape the frontend expects.
function parseResilienceCm(service, data) {
  const runs = [];
  for (const [key, value] of Object.entries(data)) {
    let r;
    try { r = JSON.parse(value); } catch { continue; }

    const raw = r.tests || {};
    const tests = Array.isArray(raw)
      ? raw
      : Object.entries(raw)
          .filter(([, s]) => s !== 'skipped')
          .map(([name, s]) => ({
            name,
            status: (s === 'pass' || s === 'passed') ? 'passed' : 'failed',
            recoveryTimeMs: r.details?.[name]?.recoveryTimeMs,
            details: r.details?.[name]?.text,
          }));

    const passed = tests.filter(t => t.status === 'passed').length;
    const overallStatus = tests.length === 0 ? 'failed'
                        : passed === tests.length ? 'passed'
                        : passed === 0 ? 'failed' : 'partial';

    runs.push({
      id: r.id || r.run_id || key,
      service: r.service || service,
      timestamp: r.timestamp || '',
      overallStatus,
      tests,
    });
  }
  runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return runs.slice(0, 10);
}

app.get('/api/resilience', async (_req, res) => {
  try {
    const names  = await cluster.getServiceNames();
    const result = {};
    await Promise.all(names.map(async (svc) => {
      result[svc] = parseResilienceCm(svc, await kc.getConfigMapData(`${svc}-resilience-results`, APPS_NS));
    }));
    res.json(result);
  } catch (err) {
    console.error('/api/resilience error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/resilience/:service', async (req, res) => {
  const svc = req.params.service;
  try { res.json(parseResilienceCm(svc, await kc.getConfigMapData(`${svc}-resilience-results`, APPS_NS))); }
  catch (err) { console.error(`/api/resilience/${svc} error:`, err.message); res.status(500).json({ error: err.message }); }
});

// ── Action routes (SSE) ──────────────────────────────────────────────────────
app.post('/api/setup/argocd',        actions.setupArgocd);
app.post('/api/setup/keda',          actions.setupKeda);
app.post('/api/setup/observability', actions.setupObservability);

app.post('/api/onboard',                   actions.onboardService);
app.post('/api/build/:service',            actions.buildService);
app.post('/api/deploy/:service',           actions.deployService);
app.post('/api/gitops/:service',           actions.registerGitops);
app.post('/api/autoscaling/:service',      actions.configureAutoscaling);
app.post('/api/monitoring/:service',       actions.configureMonitoring);
app.post('/api/services/:service/restart', actions.restartService);
app.post('/api/secrets/:service/rotate',   actions.rotateSecret);
app.post('/api/migrate/:service',          actions.runMigration);
app.post('/api/resilience/:service/run',   actions.runResilienceTests);

app.listen(PORT, () => {
  console.log(`Platform Dashboard backend listening on :${PORT}`);
  console.log(`  APPS_NS:     ${APPS_NS}`);
  console.log(`  KUBECONFIG:  ${process.env.KUBECONFIG || '(default)'}`);
});