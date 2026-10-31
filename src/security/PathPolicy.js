import fs from 'node:fs/promises';
import path from 'node:path';

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function extensionAllowed(candidate, extensions) {
  if (!extensions || extensions.length === 0) return true;
  return extensions.includes(path.extname(candidate).toLowerCase());
}

async function canonicalRoots(roots) {
  const resolved = [];
  for (const root of roots) {
    const canonical = await fs.realpath(root);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error(`La racine autorisée n’est pas un dossier: ${root}`);
    resolved.push(canonical);
  }
  return [...new Set(resolved.map((item) => path.normalize(item)))];
}

export class PathPolicy {
  static async create({ readRoots, writeRoots, deniedRoots = [] }) {
    return new PathPolicy(
      await canonicalRoots(readRoots),
      await canonicalRoots(writeRoots),
      await canonicalRoots(deniedRoots),
    );
  }

  constructor(readRoots, writeRoots, deniedRoots = []) {
    this.readRoots = readRoots;
    this.writeRoots = writeRoots;
    this.deniedRoots = deniedRoots;
  }

  async validateRead(candidate, { extensions, kind = 'file' } = {}) {
    this.#validateRaw(candidate);
    const canonical = await fs.realpath(candidate);
    this.#assertNotDenied(canonical, 'Lecture');
    if (!this.readRoots.some((root) => isInside(root, canonical))) {
      throw new Error('Lecture refusée: le chemin réel sort des racines autorisées.');
    }
    const stat = await fs.stat(canonical);
    if (kind === 'file' && !stat.isFile()) throw new Error('Lecture refusée: un fichier est attendu.');
    if (kind === 'directory' && !stat.isDirectory()) throw new Error('Lecture refusée: un dossier est attendu.');
    if (kind === 'file' && !extensionAllowed(canonical, extensions)) throw new Error('Lecture refusée: extension non autorisée pour cet outil.');
    return canonical;
  }

  async validateWrite(candidate, { extensions, kind = 'file' } = {}) {
    this.#validateRaw(candidate);
    const absolute = path.resolve(candidate);
    if (kind === 'file' && !extensionAllowed(absolute, extensions)) {
      throw new Error('Écriture refusée: extension non autorisée pour cet outil.');
    }

    let existing = absolute;
    while (true) {
      try {
        existing = await fs.realpath(existing);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error('Écriture refusée: aucun parent existant.');
        existing = parent;
      }
    }
    this.#assertNotDenied(existing, 'Écriture');
    if (!this.writeRoots.some((root) => isInside(root, existing))) {
      throw new Error('Écriture refusée: le chemin réel sort des racines autorisées.');
    }

    try {
      const canonical = await fs.realpath(absolute);
      this.#assertNotDenied(canonical, 'Écriture');
      const stat = await fs.stat(canonical);
      if (kind === 'file' && !stat.isFile()) throw new Error('Écriture refusée: la cible existante n’est pas un fichier.');
      if (kind === 'directory' && !stat.isDirectory()) throw new Error('Écriture refusée: la cible existante n’est pas un dossier.');
      if (!this.writeRoots.some((root) => isInside(root, canonical))) {
        throw new Error('Écriture refusée: la cible réelle sort des racines autorisées.');
      }
      return canonical;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return absolute;
    }
  }

  #validateRaw(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0') || !path.isAbsolute(candidate)) {
      throw new Error('Le chemin doit être absolu et valide.');
    }
  }

  #assertNotDenied(candidate, operation) {
    if (this.deniedRoots.some((root) => isInside(root, candidate))) {
      throw new Error(`${operation} refusée: le chemin réel entre dans une racine privée interdite.`);
    }
  }
}
