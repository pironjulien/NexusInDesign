import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { nativePath, normalizeNativeFilePath } = require('../plugin/commands');

test('nativePath privilégie fullName et conserve toujours le nom du fichier restauré', async () => {
  const expected = 'C:\\Projets\\sauvegardes\\backup-cible.indd';
  assert.equal(await nativePath({
    name: 'backup-cible.indd',
    fullName: { nativePath: expected },
    filePath: { nativePath: 'C:\\Dev\\mauvais-dossier' },
  }), expected);

  assert.equal(await nativePath({
    name: 'backup-é.indd',
    fullName: { url: 'file:///C:/Dev/work/backups/backup-%C3%A9.indd' },
  }), 'C:\\Dev\\work\\backups\\backup-é.indd');

  assert.equal(await nativePath({
    name: 'backup-string.indd',
    fullName: { toString: () => 'C:\\Dev\\work\\backups\\backup-string.indd' },
  }), 'C:\\Dev\\work\\backups\\backup-string.indd');

  assert.equal(await nativePath({
    name: 'backup-repli.indd',
    fullName: null,
    filePath: { nativePath: 'C:\\Dev\\work\\backups' },
  }), 'C:\\Dev\\work\\backups\\backup-repli.indd');
});

test('normalizeNativeFilePath convertit les URL locales et UNC sans ambiguïté', () => {
  assert.equal(normalizeNativeFilePath('file:///C:/Dev/test.indd'), 'C:\\Dev\\test.indd');
  assert.equal(normalizeNativeFilePath('file://serveur/partage/test.indd'), '\\\\serveur\\partage\\test.indd');
  assert.equal(normalizeNativeFilePath('[object Object]'), null);
});
