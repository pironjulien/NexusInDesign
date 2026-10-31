import fs from 'node:fs/promises';
import path from 'node:path';
import { applyWindowsPrivateAcl } from '../src/security/PrivateAcl.js';
import { TokenStore } from '../src/security/TokenStore.js';

const [secureRootInput, tokenFileInput, privateRootInput, backupRootInput, auditFileInput] = process.argv.slice(2);
const values = [secureRootInput, tokenFileInput, privateRootInput, backupRootInput, auditFileInput];
if (values.some((value) => !path.isAbsolute(value ?? ''))) {
  throw new Error('Cinq chemins absolus sont requis pour initialiser le stockage prive.');
}

const secureRoot = path.resolve(secureRootInput);
const tokenFile = path.resolve(tokenFileInput);
const privateRoot = path.resolve(privateRootInput);
const backupRoot = path.resolve(backupRootInput);
const auditFile = path.resolve(auditFileInput);
const tokenRelative = path.relative(secureRoot, tokenFile);
if (!tokenRelative || tokenRelative.startsWith('..') || path.isAbsolute(tokenRelative)) {
  throw new Error('Le secret doit rester directement sous la racine privee.');
}
for (const candidate of [backupRoot, auditFile]) {
  const relative = path.relative(privateRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Les artefacts doivent rester sous la racine privee locale.');
  }
}

await fs.mkdir(secureRoot, { recursive: true });
await fs.mkdir(privateRoot, { recursive: true });
await fs.mkdir(backupRoot, { recursive: true });
await fs.mkdir(path.dirname(auditFile), { recursive: true });
// OneDrive Files On-Demand représente parfois les fichiers synchronisés par
// des points de réanalyse. La racine reçoit donc sa DACL sans parcours ; le
// jeton est protégé séparément par TokenStore.
await applyWindowsPrivateAcl(secureRoot, { kind: 'directory', recursive: false });
await applyWindowsPrivateAcl(privateRoot, { kind: 'directory', recursive: true });
await new TokenStore(tokenFile).ensure();

const auditHandle = await fs.open(auditFile, 'a', 0o600);
await auditHandle.close();
await applyWindowsPrivateAcl(backupRoot, { kind: 'directory', recursive: true });
await applyWindowsPrivateAcl(path.dirname(auditFile), { kind: 'directory', recursive: true });
await applyWindowsPrivateAcl(auditFile, { kind: 'file' });

process.stdout.write(JSON.stringify({ initialized: true }));
