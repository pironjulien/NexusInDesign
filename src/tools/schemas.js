import { z } from 'zod';

export const id = z.number().int().positive();
export const name = z.string().min(1).max(256);
export const revision = z.number().int().min(0);
export const stateToken = z.string().regex(/^[a-f0-9]{16}$/);
export const finite = z.number().finite();
export const positive = finite.positive();
export const bounds = z.tuple([finite, finite, finite, finite]).refine(
  ([top, left, bottom, right]) => bottom > top && right > left,
  'Les limites doivent respecter [haut, gauche, bas, droite].',
);
export const rgb = z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]);
export const cmyk = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100), z.number().min(0).max(100), z.number().min(0).max(100)]);
export const lab = z.tuple([z.number().min(0).max(100), z.number().min(-128).max(127), z.number().min(-128).max(127)]);

export function strict(shape = {}) {
  return z.strictObject(shape);
}

export function documentRead(shape = {}) {
  return strict({ documentId: id, ...shape });
}

export function documentWrite(shape = {}) {
  return strict({ documentId: id, expectedRevision: revision, expectedStateToken: stateToken, ...shape });
}
