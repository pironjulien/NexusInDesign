import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareUxpPackage } from '../src/release/uxpPackage.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workOption = process.argv.indexOf('--work-root');
const requestedWorkRoot = workOption < 0 ? undefined : process.argv[workOption + 1];
if (workOption >= 0 && (!requestedWorkRoot || !path.isAbsolute(requestedWorkRoot))) {
  throw new Error('--work-root doit être un chemin absolu.');
}
const workRoot = requestedWorkRoot || path.join(repositoryRoot, 'work');
const outputDirectory = path.join(workRoot, 'uxp-package');
const reportPath = path.join(workRoot, 'uxp-package-manifest.json');

const result = await prepareUxpPackage({
  sourceDirectory: path.join(repositoryRoot, 'plugin'),
  outputDirectory,
  allowedOutputRoot: workRoot,
});
const report = { ...result, outputDirectory: undefined };
await fs.mkdir(workRoot, { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
process.stdout.write(`${JSON.stringify({ ...result, reportPath }, null, 2)}\n`);
