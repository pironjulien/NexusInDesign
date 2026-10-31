import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class OutputTargetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OutputTargetError';
    this.code = code;
  }
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertNoReparsePoint(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) throw new OutputTargetError('La cible contient une jonction ou un lien symbolique.', 'TARGET_REPARSE_POINT');
    if (stat.isDirectory()) await assertNoReparsePoint(child);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function prepareOutputTarget({ targetPath, kind, overwrite, backupRoot }) {
  if (!['file', 'directory'].includes(kind)) throw new Error('Type de sortie invalide.');
  const stat = await lstatIfExists(targetPath);
  if (!stat) return {};
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()) || stat.isSymbolicLink()) {
    throw new OutputTargetError('La cible existante n’a pas le type attendu.', 'TARGET_TYPE_MISMATCH');
  }
  if (overwrite !== true) {
    throw new OutputTargetError('La cible existe déjà. Transmettez overwrite=true pour autoriser son remplacement après copie de sécurité.', 'TARGET_EXISTS');
  }

  if (kind === 'directory') await assertNoReparsePoint(targetPath);
  const targetBackupId = randomUUID();
  const extension = kind === 'file' ? path.extname(targetPath).toLowerCase() : '';
  const targetBackupPath = path.join(backupRoot, `target-backup-${targetBackupId}${extension}`);
  if (!isInside(backupRoot, targetBackupPath)) throw new Error('Chemin de sauvegarde de cible invalide.');
  try {
    if (kind === 'file') {
      await fs.copyFile(targetPath, targetBackupPath, constants.COPYFILE_EXCL);
    } else {
      await fs.cp(targetPath, targetBackupPath, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
    }
  } catch (error) {
    if (kind === 'file') await fs.unlink(targetBackupPath).catch(() => {});
    else await fs.rm(targetBackupPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { targetBackupId, targetBackupPath, targetBackupKind: kind, targetBackupCreatedAt: new Date().toISOString() };
}
