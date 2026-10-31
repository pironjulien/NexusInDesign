import { findWindowsTcpConnectionOwnerPid } from '../bridge/BridgeDiagnostics.js';
import { verifyCodexParent } from './ParentProcessPolicy.js';

function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

export async function authorizeSharedCodexPeer({
  host,
  serverPort,
  clientPort,
  allowedPaths,
  allowedSigners,
  allowedNames,
  ownerLookup = findWindowsTcpConnectionOwnerPid,
  verifyParent = verifyCodexParent,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') throw new Error('Le courtier partagé exige la vérification de processus Windows.');
  if (typeof host !== 'string' || !validPort(serverPort) || !validPort(clientPort)) {
    throw new Error('Les extrémités TCP du client partagé sont invalides.');
  }
  const processId = await ownerLookup({ host, serverPort, clientPort, platform });
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Le processus du client partagé ne peut pas être identifié.');
  }
  const verified = await verifyParent({ allowedPaths, allowedSigners, allowedNames, parentPid: processId, platform });
  if (verified?.verified !== true) throw new Error('Le processus du client partagé n’appartient pas à une chaîne d’agent autorisée (Codex ou Claude).');
  return Object.freeze({ verified: true, processId, codexProcessId: verified.processId });
}
