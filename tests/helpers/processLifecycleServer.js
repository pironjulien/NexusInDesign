#!/usr/bin/env node

import { createApplication } from '../../src/server/createApplication.js';
import { createProcessLifecycle } from '../../src/server/ProcessLifecycle.js';

const application = await createApplication({
  argv: process.argv.slice(2),
  env: process.env,
  verifyParent: async () => ({ verified: true, testHarness: true }),
});
const lifecycle = createProcessLifecycle({ application });

try {
  await lifecycle.start();
  await application.start();
} catch (error) {
  console.error(`[nexus-indesign:test] Erreur fatale: ${error instanceof Error ? error.message : String(error)}`);
  await lifecycle.stop({ exitCode: 1, reason: 'startup-failed' });
}
