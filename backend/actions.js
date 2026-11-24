'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Root of the platform directory (backend lives inside platform/backend/)
const PLATFORM_ROOT = path.resolve(__dirname, '..');

/**
 * Resolve a script path relative to the platform root.
 */
function script(name) {
  return path.join(PLATFORM_ROOT, name);
}

/**
 * Set SSE headers and flush so the client starts receiving immediately.
 */
function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();
}

/**
 * Write one SSE event line.
 */
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Spawn a shell script, pipe stdout/stderr as SSE log events, and emit
 * done/error at the end.
 *
 * @param {import('express').Response} res
 * @param {string} scriptPath  - absolute path to the script
 * @param {string[]} args      - positional arguments
 * @param {Record<string,string>} env - extra env vars (never secrets in args)
 */
function runScriptSSE(res, scriptPath, args = [], env = {}) {
  initSSE(res);

  // Confirm to the client which script is running
  send(res, { type: 'log', line: `▶ ${path.basename(scriptPath)} ${args.join(' ')}\n` });

  const child = spawn(scriptPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  // Buffer partial lines so each SSE event is a full line
  let stdoutBuf = '';
  let stderrBuf = '';

  function flushLines(buf, addLine) {
    const parts = buf.split('\n');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i]) addLine(parts[i] + '\n');
    }
    return parts[parts.length - 1]; // leftover partial line
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    stdoutBuf = flushLines(stdoutBuf, (line) => send(res, { type: 'log', line }));
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    stderrBuf = flushLines(stderrBuf, (line) => send(res, { type: 'log', line }));
  });

  child.on('close', (code) => {
    // Flush any remaining partial lines
    if (stdoutBuf) send(res, { type: 'log', line: stdoutBuf });
    if (stderrBuf) send(res, { type: 'log', line: stderrBuf });
    send(res, { type: 'done', ok: code === 0, exitCode: code });
    res.end();
  });

  child.on('error', (err) => {
    send(res, { type: 'error', message: err.message });
    res.end();
  });

  // If the HTTP connection drops, kill the child to avoid orphan processes
  res.on('close', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// Individual action helpers — each calls runScriptSSE with the right script
// and pulls its arguments from the Express request.
// ---------------------------------------------------------------------------

/**
 * POST /api/setup/argocd
 * Body: (none required)
 */
function setupArgocd(req, res) {
  runScriptSSE(res, script('setup-argocd.sh'), []);
}

/**
 * POST /api/setup/keda
 * Body: (none required)
 */
function setupKeda(req, res) {
  runScriptSSE(res, script('setup-keda.sh'), []);
}

/**
 * POST /api/setup/observability
 * Body: (none required)
 */
function setupObservability(req, res) {
  runScriptSSE(res, script('setup-observability.sh'), []);
}

/**
 * POST /api/onboard
 * Body (JSON):
 *   repoUrl, branch, serviceName, buildMethod, dbMode, port,
 *   replicas, envVars[{key,value}], secretNames[string]
 *
 * Secret VALUES are never accepted here — they are prompted by the shell
 * script itself via kubectl create secret --dry-run, entirely in-memory.
 */
function onboardService(req, res) {
  const {
    repoUrl,
    branch,
    serviceName,
    buildMethod = 'auto',
    dbMode = 'none',
    port = '8080',
    replicas = '1',
    envVars = [],
    secretNames = [],
  } = req.body || {};

  if (!repoUrl || !branch || !serviceName) {
    res.status(400).json({ error: 'repoUrl, branch, and serviceName are required' });
    return;
  }

  // Encode env vars as KEY=VALUE pairs joined by commas (script splits on ,)
  const envVarStr = envVars.map((e) => `${e.key}=${e.value}`).join(',');
  const secretStr = secretNames.join(',');

  const args = [
    '--repo', repoUrl,
    '--branch', branch,
    '--name', serviceName,
    '--build', buildMethod,
    '--db', dbMode,
    '--port', String(port),
    '--replicas', String(replicas),
  ];
  if (envVarStr) args.push('--env', envVarStr);
  if (secretStr) args.push('--secrets', secretStr);

  runScriptSSE(res, script('onboard.sh'), args);
}

/**
 * POST /api/build/:service
 * Body: { branch? }
 */
function buildService(req, res) {
  const { service } = req.params;
  const { branch } = req.body || {};
  const args = ['--name', service];
  if (branch) args.push('--branch', branch);
  runScriptSSE(res, script('build.sh'), args);
}

/**
 * POST /api/deploy/:service
 * Body: { replicas?, tag? }
 */
function deployService(req, res) {
  const { service } = req.params;
  const { replicas, tag } = req.body || {};
  const args = ['--name', service];
  if (replicas) args.push('--replicas', String(replicas));
  if (tag) args.push('--tag', tag);
  runScriptSSE(res, script('generate-manifests.sh'), args);
}

/**
 * POST /api/gitops/:service
 * Body: { repoUrl?, branch? }
 */
function registerGitops(req, res) {
  const { service } = req.params;
  const { repoUrl, branch } = req.body || {};
  const args = ['--name', service];
  if (repoUrl) args.push('--repo', repoUrl);
  if (branch) args.push('--branch', branch);
  runScriptSSE(res, script('gitops-register.sh'), args);
}

/**
 * POST /api/autoscaling/:service
 * Body: { minReplicas?, maxReplicas?, metric?, threshold? }
 */
function configureAutoscaling(req, res) {
  const { service } = req.params;
  const { minReplicas, maxReplicas, metric, threshold } = req.body || {};
  const args = ['--name', service];
  if (minReplicas) args.push('--min', String(minReplicas));
  if (maxReplicas) args.push('--max', String(maxReplicas));
  if (metric) args.push('--metric', metric);
  if (threshold) args.push('--threshold', String(threshold));
  runScriptSSE(res, script('configure-autoscaling.sh'), args);
}

/**
 * POST /api/monitoring/:service
 * Body: { port?, path? }
 */
function configureMonitoring(req, res) {
  const { service } = req.params;
  const { port, path: metricPath } = req.body || {};
  const args = ['--name', service];
  if (port) args.push('--port', String(port));
  if (metricPath) args.push('--path', metricPath);
  runScriptSSE(res, script('configure-monitoring.sh'), args);
}

/**
 * POST /api/migrate/:service
 * Body: { phase: 'expand' | 'verify' | 'contract', migrationId? }
 */
function runMigration(req, res) {
  const { service } = req.params;
  const { phase = 'expand', migrationId } = req.body || {};

  if (!['expand', 'verify', 'contract'].includes(phase)) {
    res.status(400).json({ error: 'phase must be expand, verify, or contract' });
    return;
  }

  const args = ['--name', service, '--phase', phase];
  if (migrationId) args.push('--id', migrationId);
  runScriptSSE(res, script('run-migration.sh'), args);
}

/**
 * POST /api/resilience/:service/run
 * Body: { tests?: string[] }  — optional subset of tests to run
 */
function runResilienceTests(req, res) {
  const { service } = req.params;
  const { tests } = req.body || {};
  const args = ['--name', service];
  if (Array.isArray(tests) && tests.length) args.push('--tests', tests.join(','));
  runScriptSSE(res, script('run-resilience-tests.sh'), args);
}

/**
 * POST /api/services/:service/restart
 * Body: (none required)
 * Does a rollout restart — does not call a shell script, uses kubectl directly.
 */
function restartService(req, res) {
  const { service } = req.params;
  // Inline kubectl call — no secret data, safe to do directly
  runScriptSSE(res, '/usr/local/bin/kubectl', [
    'rollout', 'restart',
    `deployment/${service}`,
    '-n', 'apps',
  ]);
}

/**
 * POST /api/secrets/:service/rotate
 * Body: { secretName }
 * Secret values are never passed through the API — the script handles prompting
 * entirely server-side via kubectl create secret --dry-run=client -o yaml | kubectl apply -f -
 */
function rotateSecret(req, res) {
  const { service } = req.params;
  const { secretName } = req.body || {};
  if (!secretName) {
    res.status(400).json({ error: 'secretName is required' });
    return;
  }
  runScriptSSE(res, script('rotate-secret.sh'), ['--name', service, '--secret', secretName]);
}

module.exports = {
  runScriptSSE,
  setupArgocd,
  setupKeda,
  setupObservability,
  onboardService,
  buildService,
  deployService,
  registerGitops,
  configureAutoscaling,
  configureMonitoring,
  runMigration,
  runResilienceTests,
  restartService,
  rotateSecret,
};
