#!/usr/bin/env node

import { createApplication } from './server/createApplication.js';
import { createProcessLifecycle } from './server/ProcessLifecycle.js';

const application = await createApplication({ argv: process.argv.slice(2), env: process.env });
const lifecycle = createProcessLifecycle({ application });

try {
  await lifecycle.start();
  await application.start();
} catch (error) {
  console.error(`[nexus-indesign] Erreur fatale: ${error instanceof Error ? error.message : String(error)}`);
  await lifecycle.stop({ exitCode: 1, reason: 'startup-failed' });
}
