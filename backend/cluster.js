// Cluster data aggregation — reads live state via kubectl
'use strict';

const kc = require('./kubectl');

const PLATFORM_NS    = process.env.PLATFORM_NS    || 'platform';
const APPS_NS        = process.env.APPS_NS         || 'apps';
const OBS_NS         = process.env.OBS_NS          || 'observability';
const CLUSTER_NAME   = process.env.CLUSTER_NAME    || 'platform-cluster';

/** Determine service health from deployment status */
function deploymentHealth(dep) {
  const spec    = dep.spec?.replicas ?? 1;
  const ready   = dep.status?.readyReplicas ?? 0;
  const updated = dep.status?.updatedReplicas ?? 0;
  if (ready === 0 && spec > 0) return 'error';
  if (ready < spec || updated < spec) return 'degraded';
  return 'healthy';
}

/** Check if a deployment in a namespace is running */
async function componentStatus(namespace, labelSelector) {
  try {
    const list = await kc.listJson('deployment', namespace);
    const items = list.items || [];
    const matched = labelSelector
      ? items.filter(d => {
          const labels = d.metadata?.labels || {};
          return Object.entries(labelSelector).every(([k, v]) => labels[k] === v);
        })
      : items;
    if (matched.length === 0) return 'unknown';
    const allReady = matched.every(d => (d.status?.readyReplicas ?? 0) >= (d.spec?.replicas ?? 1));
    return allReady ? 'running' : 'degraded';
  } catch {
    return 'unknown';
  }
}

async function getClusterStatus() {
  const [nodeList, k8sVersion, deployments] = await Promise.allSettled([
    kc.getNodes(),
    kc.getServerVersion(),
    kc.listJson('deployment', APPS_NS),
  ]);

  const nodes = nodeList.status === 'fulfilled' ? nodeList.value.items || [] : [];
  const version = k8sVersion.status === 'fulfilled' ? k8sVersion.value : 'unknown';
  const deps = deployments.status === 'fulfilled' ? deployments.value.items || [] : [];

  // Read registry configmap
  const regCm = await kc.getConfigMapData('platform-registry', PLATFORM_NS);
  const registryAddress = regCm.registry_address || 'localhost:5050';

  const totalServices   = deps.length;
  const healthyServices = deps.filter(d => deploymentHealth(d) === 'healthy').length;

  const [argoCDStatus, kedaStatus, prometheusStatus] = await Promise.all([
    componentStatus('argocd', { 'app.kubernetes.io/name': 'argocd-server' }),
    componentStatus('keda',   { 'app': 'keda-operator' }),
    componentStatus(OBS_NS,   { 'app.kubernetes.io/name': 'prometheus' }),
  ]);

  return {
    clusterName: CLUSTER_NAME,
    registryAddress,
    namespaces: [PLATFORM_NS, APPS_NS, OBS_NS],
    totalServices,
    healthyServices,
    nodeCount: nodes.length,
    kubernetesVersion: version,
    argoCDStatus,
    kedaStatus,
    prometheusStatus,
  };
}

async function getServices() {
  const list = await kc.listJson('deployment', APPS_NS);
  const deps = list.items || [];

  return deps.map(dep => {
    const name    = dep.metadata?.name ?? 'unknown';
    const labels  = dep.metadata?.labels || {};
    const ann     = dep.metadata?.annotations || {};
    const desired = dep.spec?.replicas ?? 1;
    const ready   = dep.status?.readyReplicas ?? 0;
    const image   = dep.spec?.template?.spec?.containers?.[0]?.image ?? '';

    return {
      name,
      namespace:      APPS_NS,
      replicas:       { ready, desired },
      image,
      repo:           ann['platform.io/repo']         || '',
      branch:         ann['platform.io/branch']       || '',
      buildMethod:    ann['platform.io/build-method'] || 'unknown',
      dbMode:         ann['platform.io/db-mode']      || 'none',
      port:           parseInt(ann['platform.io/port'] || '8080', 10),
      status:         deploymentHealth(dep),
      lastDeployedAt: dep.metadata?.creationTimestamp || undefined,
    };
  });
}

async function getServiceNames() {
  try {
    const svcs = await getServices();
    return svcs.map(s => s.name);
  } catch {
    return [];
  }
}

module.exports = { getClusterStatus, getServices, getServiceNames };
