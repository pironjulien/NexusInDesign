import path from 'node:path';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function integer(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return parsed;
}

function roots(value, name) {
  if (!value) throw new ConfigurationError(`${name} est obligatoire.`);
  const items = value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0 || items.some((item) => !path.isAbsolute(item))) {
    throw new ConfigurationError(`${name} doit contenir au moins un chemin absolu.`);
  }
  return items;
}

function optionalList(value) {
  return value?.split(path.delimiter).map((item) => item.trim()).filter(Boolean) ?? [];
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function loadConfig({ argv = [], env = process.env } = {}) {
  if (argv.includes('--pair') || env.INDESIGN_MCP_PAIRING === '1') {
    throw new ConfigurationError('Le mode --pair est supprimé; utilisez bridge_open_pairing_window depuis la tâche propriétaire.');
  }
  const tokenFile = env.INDESIGN_MCP_TOKEN_FILE;
  if (!tokenFile || !path.isAbsolute(tokenFile)) {
    throw new ConfigurationError('INDESIGN_MCP_TOKEN_FILE doit désigner un fichier absolu dans NexusSecure.');
  }
  const backupRoot = env.INDESIGN_MCP_BACKUP_ROOT;
  if (!backupRoot || !path.isAbsolute(backupRoot)) {
    throw new ConfigurationError('INDESIGN_MCP_BACKUP_ROOT doit désigner un dossier absolu explicitement autorisé.');
  }
  const secretRoot = path.dirname(path.resolve(tokenFile));
  if (env.INDESIGN_MCP_PRIVATE_ROOT && !path.isAbsolute(env.INDESIGN_MCP_PRIVATE_ROOT)) {
    throw new ConfigurationError('INDESIGN_MCP_PRIVATE_ROOT doit désigner un dossier absolu.');
  }
  const privateRoot = env.INDESIGN_MCP_PRIVATE_ROOT
    ? path.resolve(env.INDESIGN_MCP_PRIVATE_ROOT)
    : secretRoot;
  if (!isInside(privateRoot, path.resolve(backupRoot))) {
    throw new ConfigurationError('INDESIGN_MCP_BACKUP_ROOT doit rester dans le stockage privé local déclaré.');
  }
  const auditFile = env.INDESIGN_MCP_AUDIT_FILE ? path.resolve(env.INDESIGN_MCP_AUDIT_FILE) : undefined;
  if (auditFile && !isInside(privateRoot, auditFile)) {
    throw new ConfigurationError('INDESIGN_MCP_AUDIT_FILE doit rester dans le stockage privé local déclaré.');
  }

  const deniedRoots = [...new Set([
    secretRoot,
    privateRoot,
    ...optionalList(env.INDESIGN_MCP_DENIED_ROOTS).map((item) => path.resolve(item)),
  ])];

  const toolProfile = env.INDESIGN_MCP_TOOL_PROFILE || 'core';
  if (!['core', 'full'].includes(toolProfile)) {
    throw new ConfigurationError('INDESIGN_MCP_TOOL_PROFILE doit valoir core ou full.');
  }

  return Object.freeze({
    host: '127.0.0.1',
    port: integer(env.INDESIGN_MCP_PORT, 33171, 'INDESIGN_MCP_PORT', { min: 0, max: 65535 }),
    tokenFile,
    privateRoot,
    backupRoot,
    readRoots: roots(env.INDESIGN_MCP_READ_ROOTS, 'INDESIGN_MCP_READ_ROOTS'),
    writeRoots: roots(env.INDESIGN_MCP_WRITE_ROOTS, 'INDESIGN_MCP_WRITE_ROOTS'),
    deniedRoots,
    authenticationTimeoutMs: integer(env.INDESIGN_MCP_AUTH_TIMEOUT_MS, 10_000, 'INDESIGN_MCP_AUTH_TIMEOUT_MS', { min: 1_000, max: 60_000 }),
    commandTimeoutMs: integer(env.INDESIGN_MCP_COMMAND_TIMEOUT_MS, 30_000, 'INDESIGN_MCP_COMMAND_TIMEOUT_MS', { min: 1_000, max: 120_000 }),
    maxQueueLength: integer(env.INDESIGN_MCP_MAX_QUEUE, 100, 'INDESIGN_MCP_MAX_QUEUE', { min: 1, max: 1_000 }),
    maxPayloadBytes: integer(env.INDESIGN_MCP_MAX_PAYLOAD_BYTES, 4_194_304, 'INDESIGN_MCP_MAX_PAYLOAD_BYTES', { min: 65_536, max: 4_194_304 }),
    allowedParentPaths: optionalList(env.INDESIGN_MCP_ALLOWED_PARENT_PATHS).length
      ? optionalList(env.INDESIGN_MCP_ALLOWED_PARENT_PATHS)
      : ['C:\\Program Files\\WindowsApps'],
    allowedParentNames: (env.INDESIGN_MCP_ALLOWED_PARENT_NAMES ?? 'codex.exe').split('|').map((item) => item.trim().toLowerCase()).filter(Boolean),
    allowedParentSigners: (env.INDESIGN_MCP_ALLOWED_PARENT_SIGNERS ?? 'OpenAI OpCo, LLC').split('|').map((item) => item.trim()).filter(Boolean),
    auditFile,
    toolProfile,
    backupMaxAgeHours: integer(env.INDESIGN_MCP_BACKUP_MAX_AGE_HOURS, 24, 'INDESIGN_MCP_BACKUP_MAX_AGE_HOURS', { min: 1, max: 720 }),
    backupMaxFiles: integer(env.INDESIGN_MCP_BACKUP_MAX_FILES, 200, 'INDESIGN_MCP_BACKUP_MAX_FILES', { min: 1, max: 10_000 }),
  });
}
