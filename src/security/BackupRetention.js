import fs from 'node:fs/promises';
import path from 'node:path';

const BACKUP_NAME = /^backup-[a-f0-9-]{24,80}\.indd$/i;
const TARGET_BACKUP_NAME = /^target-backup-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\.[a-z0-9]{1,12})?$/i;
const RESTORED_NAME = /^restore-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.indd$/i;

export async function cleanupBackups(directory, { maxAgeMs, maxFiles, now = Date.now() }) {
  const leasePath = path.join(directory, '.silent-runtime', '.mutation-lease.json');
  const activeLease = await fs.lstat(leasePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (activeLease) {
    if (!activeLease.isFile() || activeLease.isSymbolicLink()) throw new Error('Le verrou de mutation InDesign est invalide; la rétention est suspendue.');
    return { inspected: 0, removed: 0, skippedForActiveMutation: true };
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if ((!entry.isFile() && !entry.isDirectory()) || (!BACKUP_NAME.test(entry.name) && !TARGET_BACKUP_NAME.test(entry.name))) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) continue;
    const companions = [];
    if (BACKUP_NAME.test(entry.name)) {
      const metadataPath = filePath.replace(/\.indd$/i, '.meta.json');
      const metadataStat = await fs.lstat(metadataPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (metadataStat?.isFile() && !metadataStat.isSymbolicLink()) companions.push(metadataPath);
    }
    candidates.push({ filePath, mtimeMs: stat.mtimeMs, directory: stat.isDirectory(), companions });
  }

  let skippedOpenRestored = 0;
  const restoredDirectory = path.join(directory, 'restored');
  const restoredDirectoryStat = await fs.lstat(restoredDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (restoredDirectoryStat?.isDirectory() && !restoredDirectoryStat.isSymbolicLink()) {
    const restoredEntries = await fs.readdir(restoredDirectory, { withFileTypes: true });
    for (const entry of restoredEntries) {
      const match = entry.isFile() ? entry.name.match(RESTORED_NAME) : null;
      if (!match) continue;
      const filePath = path.join(restoredDirectory, entry.name);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const markerPath = path.join(restoredDirectory, `restore-${match[1]}.open.json`);
      const markerStat = await fs.lstat(markerPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      // Un marqueur, même illisible, signifie « potentiellement ouvert ». La
      // rétention choisit toujours la conservation plutôt qu’une perte active.
      if (markerStat) {
        skippedOpenRestored += 1;
        continue;
      }
      candidates.push({ filePath, mtimeMs: stat.mtimeMs, directory: false, companions: [] });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const removed = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (index >= maxFiles || now - candidate.mtimeMs > maxAgeMs) {
      if (candidate.directory) await fs.rm(candidate.filePath, { recursive: true, force: true });
      else await fs.unlink(candidate.filePath);
      for (const companion of candidate.companions) await fs.unlink(companion).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      removed.push(path.basename(candidate.filePath));
    }
  }
  return { inspected: candidates.length, removed: removed.length, skippedOpenRestored };
}
