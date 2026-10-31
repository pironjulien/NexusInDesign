import { loadConfig } from '../config.js';
import { verifyCodexParent } from '../security/ParentProcessPolicy.js';
import { Application } from './Application.js';

export async function createApplication({ argv = [], env = process.env, verifyParent = verifyCodexParent, transportFactory, silentBridgeFactory, bridgeFactory, sharedBridgeFactory, operationMutexGuardFactory, portOwnerLookup } = {}) {
  const config = loadConfig({ argv, env });
  return new Application({ config, verifyParent, transportFactory, silentBridgeFactory, bridgeFactory, sharedBridgeFactory, operationMutexGuardFactory, portOwnerLookup });
}
