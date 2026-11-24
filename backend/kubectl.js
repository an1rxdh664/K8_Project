// Thin wrapper around kubectl — all cluster reads go through here.
// Never writes secrets or any sensitive data to disk.
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const KUBECONFIG = process.env.KUBECONFIG || '';
const KUBECTL    = process.env.KUBECTL_BIN || 'kubectl';

function baseArgs() {
  const args = [];
  if (KUBECONFIG) args.push(`--kubeconfig=${KUBECONFIG}`);
  return args;
}

async function run(args, opts = {}) {
  const all = [...baseArgs(), ...args];
  const { stdout } = await execFileAsync(KUBECTL, all, {
    timeout: opts.timeout || 15000,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  return stdout.trim();
}

/** kubectl get <resource> -n <ns> -o json → parsed object */
async function getJson(resource, namespace, name) {
  const args = ['get', resource, ...(name ? [name] : []),
    '-n', namespace, '-o', 'json'];
  const out = await run(args);
  return JSON.parse(out);
}

/** kubectl get <resource> -n <ns> --all-namespaces -o json → parsed list */
async function listJson(resource, namespace) {
  const args = namespace
    ? ['get', resource, '-n', namespace, '-o', 'json']
    : ['get', resource, '--all-namespaces', '-o', 'json'];
  const out = await run(args);
  return JSON.parse(out);
}

/** kubectl logs pod -n ns --tail=N */
async function podLogs(pod, namespace, tail = 100) {
  const out = await run(['logs', pod, '-n', namespace, `--tail=${tail}`], { timeout: 20000 });
  return out;
}

/** kubectl get nodes -o json */
async function getNodes() {
  const out = await run(['get', 'nodes', '-o', 'json']);
  return JSON.parse(out);
}

/** kubectl version --client=false -o json */
async function getServerVersion() {
  try {
    const out = await run(['version', '-o', 'json']);
    const v = JSON.parse(out);
    return v.serverVersion?.gitVersion || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** kubectl get configmap <name> -n <ns> -o jsonpath='{.data}' */
async function getConfigMapData(name, namespace) {
  try {
    const cm = await getJson('configmap', namespace, name);
    return cm.data || {};
  } catch {
    return {};
  }
}

module.exports = { run, getJson, listJson, podLogs, getNodes, getServerVersion, getConfigMapData };
