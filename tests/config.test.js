import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ConfigurationError, loadConfig } from '../src/config.js';

const base = {
  INDESIGN_MCP_TOKEN_FILE: 'C:\\Secure\\token',
  INDESIGN_MCP_PRIVATE_ROOT: 'C:\\Private',
  INDESIGN_MCP_READ_ROOTS: 'C:\\Dev',
  INDESIGN_MCP_WRITE_ROOTS: 'C:\\Output',
  INDESIGN_MCP_BACKUP_ROOT: 'C:\\Private\\backups',
};

test('la configuration refuse tout dossier de sauvegarde implicite', () => {
  const env = { ...base };
  delete env.INDESIGN_MCP_BACKUP_ROOT;
  assert.throws(() => loadConfig({ env }), ConfigurationError);
});

test('la configuration est fermée sur loopback et le port contractuel', () => {
  const config = loadConfig({ env: base });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 33171);
  assert.equal(config.maxPayloadBytes, 4_194_304);
  assert.equal(config.privateRoot, path.normalize(base.INDESIGN_MCP_PRIVATE_ROOT));
  assert.equal(config.backupRoot, path.normalize(base.INDESIGN_MCP_BACKUP_ROOT));
  assert.ok(config.deniedRoots.includes(path.normalize('C:\\Secure')));
  assert.ok(config.deniedRoots.includes(path.normalize('C:\\Private')));
  assert.ok(config.allowedParentSigners.includes('OpenAI OpCo, LLC'));
  assert.deepEqual(config.allowedParentNames, ['codex.exe']);
  assert.deepEqual(loadConfig({ env: { ...base, INDESIGN_MCP_ALLOWED_PARENT_NAMES: 'codex.exe|Claude.exe' } }).allowedParentNames, ['codex.exe', 'claude.exe']);
});

test('la configuration exclut le secret synchronisé et les données privées locales', () => {
  const config = loadConfig({ env: { ...base, INDESIGN_MCP_DENIED_ROOTS: 'C:\\AutreCoffre' } });
  assert.deepEqual(config.deniedRoots, [
    path.normalize('C:\\Secure'),
    path.normalize('C:\\Private'),
    path.normalize('C:\\AutreCoffre'),
  ]);
});

test('sauvegardes et audit ne peuvent pas quitter le stockage privé local', () => {
  assert.throws(() => loadConfig({ env: { ...base, INDESIGN_MCP_BACKUP_ROOT: 'C:\\Output\\backups' } }), ConfigurationError);
  assert.throws(() => loadConfig({ env: { ...base, INDESIGN_MCP_AUDIT_FILE: 'C:\\Output\\audit.jsonl' } }), ConfigurationError);
});

test('le démarrage de production refuse les anciens modes d’appairage implicites', () => {
  assert.throws(
    () => loadConfig({ argv: ['--pair'], env: base }),
    (error) => error instanceof ConfigurationError && /bridge_open_pairing_window/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ env: { ...base, INDESIGN_MCP_PAIRING: '1' } }),
    (error) => error instanceof ConfigurationError && /bridge_open_pairing_window/.test(error.message),
  );
});

test('le profil d’outils vaut core par défaut et refuse une valeur inconnue', () => {
  assert.equal(loadConfig({ env: base }).toolProfile, 'core');
  assert.equal(loadConfig({ env: { ...base, INDESIGN_MCP_TOOL_PROFILE: 'full' } }).toolProfile, 'full');
  assert.throws(() => loadConfig({ env: { ...base, INDESIGN_MCP_TOOL_PROFILE: 'tout' } }), ConfigurationError);
});
