import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRegistryManifest } from './registryManifest.js';
import { officialDomIndexInfo } from './AdobeDomIndex.js';
import { bridgeUnavailableStatus } from '../bridge/BridgeDiagnostics.js';

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function check(id, status, details = {}) {
  return { id, status, ...details };
}

async function storageCheck(config) {
  try {
    const secretRoot = path.dirname(path.resolve(config.tokenFile));
    const privateRoot = path.resolve(config.privateRoot ?? secretRoot);
    const targets = [
      { value: config.tokenFile, kind: 'file' },
      { value: config.backupRoot, kind: 'directory' },
      ...(config.auditFile ? [{ value: config.auditFile, kind: 'file' }] : []),
    ];
    const stats = await Promise.all(targets.map((target) => fs.lstat(target.value)));
    const valid = targets.every((target, index) => {
      const stat = stats[index];
      return !stat.isSymbolicLink()
        && (target.kind === 'file' ? stat.isFile() : stat.isDirectory())
        && (
          (target.value === config.tokenFile && isInside(secretRoot, path.resolve(target.value)))
          || (target.value !== config.tokenFile && isInside(privateRoot, path.resolve(target.value)))
        );
    });
    return check('private-storage', valid ? 'pass' : 'fail', {
      persistentAudit: Boolean(config.auditFile),
      checkedObjects: targets.length,
    });
  } catch (error) {
    return check('private-storage', 'fail', { code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'STORAGE_UNAVAILABLE' });
  }
}

function pluginSnapshot(bridge, bridgeError) {
  if (bridgeError || !bridge) {
    return {
      ...bridgeUnavailableStatus(bridgeError),
      engineAvailable: false,
      usable: false,
    };
  }
  try {
    const status = bridge.status();
    if (status.available === false) {
      return {
        ...bridgeUnavailableStatus(status),
        engineAvailable: false,
        usable: false,
      };
    }
    return {
      available: true,
      engineAvailable: true,
      listening: status.listening === true,
      connected: status.connected === true,
      authenticated: status.authenticated === true,
      usable: status.connected === true && status.authenticated === true,
      listenerOwnedByThisInstance: status.brokerRole === 'owner' && status.listening === true,
      ownsPluginSession: status.brokerRole === 'owner' && status.authenticated === true,
      pluginSessionUsable: status.authenticated === true,
      sharedConnection: status.sharedConnection === true,
      brokerRole: status.brokerRole,
      brokerConnected: status.brokerConnected,
      brokerOwnerPid: status.brokerOwnerPid,
      pluginVersion: typeof status.pluginVersion === 'string' ? status.pluginVersion : undefined,
      pairingActive: status.pairingActive === true,
    };
  } catch {
    return {
      ...bridgeUnavailableStatus({ code: 'BRIDGE_STATUS_FAILED' }),
      engineAvailable: false,
      usable: false,
    };
  }
}

export async function runInDesignDoctor({ tools, config, bridge, bridgeError, silentBridge, silentBridgeError, includeTools = false }) {
  const registry = buildRegistryManifest(tools, { includeTools });
  let officialDom;
  try {
    officialDom = { available: true, ...officialDomIndexInfo() };
  } catch {
    officialDom = { available: false, code: 'OFFICIAL_DOM_INDEX_INVALID' };
  }
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const plugin = pluginSnapshot(bridge, bridgeError);
  const silent = {
    engineAvailable: Boolean(silentBridge) && !silentBridgeError,
    hostChecked: false,
    hostAvailable: null,
  };
  const checks = [
    check('node-runtime', nodeMajor === 24 ? 'pass' : 'fail', { observed: process.versions.node, expected: '24.x' }),
    check('loopback-only', config.host === '127.0.0.1' ? 'pass' : 'fail'),
    check('parent-policy', config.allowedParentPaths.length > 0 && config.allowedParentSigners.length > 0 ? 'pass' : 'fail', {
      allowedPathCount: config.allowedParentPaths.length,
      allowedSignerCount: config.allowedParentSigners.length,
      allowedNameCount: config.allowedParentNames?.length ?? 0,
    }),
    await storageCheck(config),
    check('tool-registry', /^[a-f0-9]{64}$/.test(registry.registryHash) && registry.toolCount === tools.length ? 'pass' : 'fail', {
      toolCount: registry.toolCount,
      toolProfile: config.toolProfile ?? 'full',
      registryHash: registry.registryHash,
    }),
    check('official-dom-index', officialDom.available ? 'pass' : 'fail', officialDom.available
      ? { entryCount: officialDom.entryCount, sourceRevision: officialDom.source.commit }
      : { code: officialDom.code }),
    check('plugin-channel', plugin.usable ? 'pass' : plugin.available && plugin.listening ? 'warn' : 'unavailable', plugin.available
      ? {
          available: true,
          listening: plugin.listening,
          connected: plugin.connected,
          authenticated: plugin.authenticated,
          listenerOwnedByThisInstance: plugin.listenerOwnedByThisInstance,
          ownsPluginSession: plugin.ownsPluginSession,
          pluginSessionUsable: plugin.pluginSessionUsable,
          sharedConnection: plugin.sharedConnection,
          brokerRole: plugin.brokerRole,
          ...(plugin.brokerOwnerPid !== undefined ? { brokerOwnerPid: plugin.brokerOwnerPid } : {}),
        }
      : {
          available: false,
          reason: plugin.reason,
          code: plugin.code,
          ...(plugin.port !== undefined ? { port: plugin.port } : {}),
          ...(plugin.listenerOwnerPid !== undefined ? { listenerOwnerPid: plugin.listenerOwnerPid } : {}),
          listenerOwnedByThisInstance: false,
          ownsPluginSession: false,
        }),
    check('silent-channel', silent.engineAvailable ? 'pass' : 'unavailable', { hostChecked: false }),
  ];
  const hasFailure = checks.some((entry) => entry.status === 'fail');
  const hasUsableChannel = plugin.usable || silent.engineAvailable;
  const nextActions = [];
  if (plugin.code === 'EADDRINUSE') nextActions.push('Le port possède déjà un propriétaire mais son courtier n’a pas pu être authentifié; vérifier que toutes les tâches utilisent la même installation et le même stockage privé.');
  else if (!plugin.usable) nextActions.push('Charger ou reconnecter le plugin UXP authentifié pour les outils structurés et le canal UXP complet.');
  if (silent.engineAvailable) nextActions.push('Utiliser silent_status pour vérifier le processus InDesign réel; le doctor local ne démarre jamais InDesign.');
  else nextActions.push('Réparer le canal silencieux avant toute exécution sans panneau.');
  if (!config.auditFile) nextActions.push('Configurer un journal privé persistant pour conserver les preuves au-delà de la sortie standard.');
  return {
    status: hasFailure ? 'error' : hasUsableChannel ? (plugin.usable ? 'ready' : 'ready-unverified') : 'degraded',
    checkedAt: new Date().toISOString(),
    hostProbePerformed: false,
    checks,
    channels: { plugin, silent },
    capabilities: {
      localDiagnostics: true,
      officialDomReference: officialDom.available,
      pluginStructuredTools: plugin.usable,
      pluginFullUxp: plugin.usable,
      silentInspectionEngine: silent.engineAvailable,
      silentFullUxpEngine: silent.engineAvailable,
    },
    registry,
    officialDom,
    nextActions,
  };
}
