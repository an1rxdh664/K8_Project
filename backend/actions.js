'use strict';
/**
 * backend/actions.js  (fixed version)
 *
 * What was wrong in the original:
 *  - Every per-service route called the shell scripts with `--name <service>`,
 *    but build.sh, generate-manifests.sh, gitops-register.sh,
 *    configure-autoscaling.sh, configure-monitoring.sh, run-migration.sh and
 *    run-resilience-tests.sh all take the *config file path* as a positional
 *    argument. They died with "Unknown option: --name".
 *  - Flag names did not match (--metric/--threshold, --port/--path, --tests,
 *    --secret, ...).
 *  - /api/onboard sent env vars and secret names as ONE comma-joined argument;
 *    onboard.sh expects one --env / --secret flag per item.
 *  - Scripts ran with cwd = backend/, so manifests were written to
 *    backend/manifests while the CLI uses <repo>/manifests. Now cwd = repo root.
 *  - kubectl was hardcoded to /usr/bin/kubectl and /usr/local/bin/kubectl.
 *  - The backend's own PORT / BRANCH / DB_MODE... env vars leaked into scripts
 *    (onboard.sh reads PORT, BRANCH, DB_MODE, BUILD_METHOD, SERVICE_NAME from env).
 *  - No input validation; a service name with "../" could escape manifests/.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLATFORM_ROOT = path.resolve(__dirname, '..');
const MANIFEST_DIR = path.join(PLATFORM_ROOT, 'manifests');
const APPS_NS = process.env.APPS_NS || 'apps';

const SERVICE_RE = /^[a-z][a-z0-9-]{1,51}$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RESILIENCE_TESTS = ['pod-failure', 'network-partition', 'resource-exhaustion'];

const script = (name) => path.join(PLATFORM_ROOT, name);
const confFor = (svc) => path.join(MANIFEST_DIR, `${svc}.onboard.conf`);

/** Environment for child scripts: inherit PATH/HOME/KUBECONFIG, drop names the scripts read as inputs. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['PORT', 'BRANCH', 'REPO_URL', 'SERVICE_NAME', 'DB_MODE', 'BUILD_METHOD', 'REPLICAS']) {
    delete env[k];
  }
  return { ...env, NON_INTERACTIVE: 'true', GIT_TERMINAL_PROMPT: '0', ...extra };
}

// ── SSE plumbing ────────────────────────────────────────────────────────────

function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Keep proxies / browsers from closing an idle stream during long builds.
  const hb = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
  res.on('close', () => clearInterval(hb));
}

function send(res, obj) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Run steps one after another, streaming output as SSE.
 * step = { cmd: string, args: string[], env?: object, isScript?: boolean }
 * Scripts are run through `bash` so a missing executable bit does not break them.
 */
function runSteps(res, steps) {
  initSSE(res);
  let finished = false;
  let current = null;

  res.on('close', () => {
    if (!finished && current && !current.killed) current.kill('SIGTERM');
  });

  const finish = (obj) => {
    if (finished) return;
    finished = true;
    send(res, obj);
    res.end();
  };

  const next = (i) => {
    if (i >= steps.length) return finish({ type: 'done', ok: true, exitCode: 0 });

    const step = steps[i];
    const cmd = step.isScript ? 'bash' : step.cmd;
    const args = step.isScript ? [step.cmd, ...step.args] : step.args;
    send(res, { type: 'log', line: `\n▶ ${path.basename(step.cmd)} ${step.args.join(' ')}\n` });

    current = spawn(cmd, args, {
      cwd: PLATFORM_ROOT,
      env: childEnv(step.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) if (p) send(res, { type: 'log', line: p + '\n' });
    };
    current.stdout.on('data', onData);
    current.stderr.on('data', onData);

    current.on('error', (err) => finish({ type: 'error', message: `${cmd}: ${err.message}` }));
    current.on('close', (code) => {
      if (buf) send(res, { type: 'log', line: buf + '\n' });
      if (code !== 0) return finish({ type: 'done', ok: false, exitCode: code });
      next(i + 1);
    });
  };

  next(0);
}

const sh = (name, args = [], env) => ({ cmd: script(name), args, env, isScript: true });
const kubectl = (args) => ({ cmd: 'kubectl', args });

// ── Validation helpers ──────────────────────────────────────────────────────

function bad(res, message) {
  res.status(400).json({ error: message });
}

/** Resolve :service param to its onboarding config, or answer with an error. */
function requireService(req, res) {
  const svc = req.params.service;
  if (!SERVICE_RE.test(svc)) { bad(res, 'invalid service name'); return null; }
  const conf = confFor(svc);
  if (!fs.existsSync(conf)) {
    res.status(404).json({ error: `No onboarding config for "${svc}" (${conf}). Onboard it first.` });
    return null;
  }
  return { svc, conf };
}

/** Rewrite KEY="value" in an .onboard.conf (used for branch / replicas / repo overrides). */
function setConfValue(conf, key, value) {
  const text = fs.readFileSync(conf, 'utf8');
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  fs.writeFileSync(conf, re.test(text) ? text.replace(re, line) : `${text}\n${line}\n`);
}

// ── Setup actions ───────────────────────────────────────────────────────────

const setupArgocd = (_req, res) => runSteps(res, [sh('setup-argocd.sh')]);
const setupKeda = (_req, res) => runSteps(res, [sh('setup-keda.sh')]);
const setupObservability = (_req, res) => runSteps(res, [sh('setup-observability.sh')]);

// ── Onboard: onboard.sh -> build.sh -> generate-manifests.sh -> kubectl apply ─

function onboardService(req, res) {
  const {
    repoUrl, branch, serviceName,
    buildMethod = 'auto', dbMode = 'none',
    port = 8080, replicas = 1,
    envVars = [], secretNames = [],
  } = req.body || {};

  if (!repoUrl || !branch || !serviceName) return bad(res, 'repoUrl, branch, and serviceName are required');
  if (!SERVICE_RE.test(serviceName)) return bad(res, 'serviceName must start with a letter; lowercase letters, digits, hyphens; 2–52 chars');
  if (!/^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(repoUrl)) return bad(res, 'repoUrl must be an http(s) or ssh git URL');
  if (!BRANCH_RE.test(branch)) return bad(res, 'invalid branch name');
  if (!['auto', 'buildpacks', 'dockerfile'].includes(buildMethod)) return bad(res, 'invalid buildMethod');
  if (!['none', 'isolated', 'shared'].includes(dbMode)) return bad(res, 'invalid dbMode');
  const portN = parseInt(port, 10);
  const repN = parseInt(replicas, 10);
  if (!(portN >= 1 && portN <= 65535)) return bad(res, 'port must be 1–65535');
  if (!(repN >= 1)) return bad(res, 'replicas must be >= 1');
  for (const e of envVars) if (!ENV_KEY_RE.test(e.key || '')) return bad(res, `invalid env var name: ${e.key}`);
  for (const s of secretNames) if (!SECRET_KEY_RE.test(s)) return bad(res, `invalid secret name: ${s}`);

  const args = [
    '--repo', repoUrl, '--branch', branch, '--name', serviceName,
    '--build-method', buildMethod, '--db-mode', dbMode,
    '--port', String(portN), '--replicas', String(repN),
    '--output-dir', MANIFEST_DIR, '--non-interactive',
  ];
  // One flag per item (onboard.sh appends each to an array)
  for (const e of envVars) args.push('--env', `${e.key}=${e.value ?? ''}`);
  for (const s of secretNames) args.push('--secret', s);

  const conf = confFor(serviceName);
  runSteps(res, [
    sh('onboard.sh', args),
    sh('build.sh', [conf]),
    sh('generate-manifests.sh', [conf]),
    kubectl(['apply', '-k', path.join(MANIFEST_DIR, serviceName)]),
  ]);
}

// ── Per-service lifecycle (all use the positional conf path) ────────────────

function buildService(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { branch } = req.body || {};
  if (branch) {
    if (!BRANCH_RE.test(branch)) return bad(res, 'invalid branch name');
    setConfValue(s.conf, 'BRANCH', branch);
  }
  runSteps(res, [sh('build.sh', [s.conf])]);
}

function deployService(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { replicas } = req.body || {};
  if (replicas) {
    const n = parseInt(replicas, 10);
    if (!(n >= 1)) return bad(res, 'replicas must be >= 1');
    setConfValue(s.conf, 'REPLICAS', String(n));
  }
  runSteps(res, [
    sh('generate-manifests.sh', [s.conf]),
    kubectl(['apply', '-k', path.join(MANIFEST_DIR, s.svc)]),
  ]);
}

function registerGitops(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { repoUrl, branch } = req.body || {};
  if (repoUrl) {
    if (!/^(https?:\/\/|git@|ssh:\/\/)\S+$/.test(repoUrl)) return bad(res, 'invalid repoUrl');
    setConfValue(s.conf, 'REPO_URL', repoUrl);
  }
  if (branch) {
    if (!BRANCH_RE.test(branch)) return bad(res, 'invalid branch name');
    setConfValue(s.conf, 'BRANCH', branch);
  }
  runSteps(res, [sh('gitops-register.sh', [s.conf])]);
}

function configureAutoscaling(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { minReplicas, maxReplicas, metric, trigger, threshold } = req.body || {};
  const t = trigger || metric || 'cpu';
  if (!['cpu', 'memory', 'http', 'cron'].includes(t)) return bad(res, 'trigger must be cpu | memory | http | cron');
  const args = [s.conf, '--trigger', t];
  if (minReplicas !== undefined && minReplicas !== '') args.push('--min', String(parseInt(minReplicas, 10)));
  if (maxReplicas) args.push('--max', String(parseInt(maxReplicas, 10)));
  if (threshold) {
    const flag = { cpu: '--cpu-target', memory: '--mem-target', http: '--http-target' }[t];
    if (flag) args.push(flag, String(parseInt(threshold, 10)));
  }
  runSteps(res, [sh('configure-autoscaling.sh', args)]);
}

function configureMonitoring(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { port, path: metricPath } = req.body || {};
  const args = [s.conf];
  if (port) args.push('--metrics-port', String(parseInt(port, 10)));
  if (metricPath) {
    if (!/^\/[A-Za-z0-9._\/-]*$/.test(metricPath)) return bad(res, 'invalid metrics path');
    args.push('--metrics-path', metricPath);
  }
  runSteps(res, [sh('configure-monitoring.sh', args)]);
}

function runMigration(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { phase = 'expand', migrationId } = req.body || {};
  if (!['expand', 'verify', 'contract', 'all'].includes(phase)) return bad(res, 'phase must be expand, verify, contract or all');
  const args = [s.conf, '--phase', phase];
  if (migrationId) {
    if (!/^[A-Za-z0-9._-]+$/.test(migrationId)) return bad(res, 'invalid migrationId');
    args.push('--id', migrationId);
  }
  runSteps(res, [sh('run-migration.sh', args)]);
}

function runResilienceTests(req, res) {
  const s = requireService(req, res); if (!s) return;
  const { tests } = req.body || {};
  if (!Array.isArray(tests) || tests.length === 0) {
    return runSteps(res, [sh('run-resilience-tests.sh', [s.conf])]); // all three, one stored run
  }
  for (const t of tests) if (!RESILIENCE_TESTS.includes(t)) return bad(res, `unknown test: ${t}`);
  // The script runs one test per --test flag, so a subset runs sequentially (one stored run each).
  runSteps(res, tests.map((t) => sh('run-resilience-tests.sh', [s.conf, '--test', t])));
}

function restartService(req, res) {
  const svc = req.params.service;
  if (!SERVICE_RE.test(svc)) return bad(res, 'invalid service name');
  runSteps(res, [kubectl(['rollout', 'restart', `deployment/${svc}`, '-n', APPS_NS])]);
}

function rotateSecret(req, res) {
  const svc = req.params.service;
  const { secretName } = req.body || {};
  if (!SERVICE_RE.test(svc)) return bad(res, 'invalid service name');
  if (!secretName || !SECRET_KEY_RE.test(secretName)) return bad(res, 'valid secretName is required');
  // Value is auto-generated by the script when no TTY is attached; it never travels through the API.
  runSteps(res, [sh('rotate-secret.sh', ['--service', svc, '--key', secretName])]);
}

module.exports = {
  runSteps,
  setupArgocd, setupKeda, setupObservability,
  onboardService, buildService, deployService, registerGitops,
  configureAutoscaling, configureMonitoring,
  runMigration, runResilienceTests,
  restartService, rotateSecret,
};