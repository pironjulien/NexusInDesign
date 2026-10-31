import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const UXP_RUNTIME_FILES = Object.freeze([
  'manifest.json',
  'index.html',
  'index.js',
  'commands.js',
  'security-crypto.js',
  'validation.js',
  'vendor/js-sha256.js',
  'vendor/LICENSE.js-sha256.txt',
]);

const FORBIDDEN_CONTENT = [
  { code: 'PRIVATE_KEY', pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { code: 'PAIRING_SECRET', pattern: /(?:bridge|pairing)[_-]?secret\s*[:=]/i },
  { code: 'ENV_FILE', pattern: /(?:^|[\\/])\.env(?:$|[.\\/])/i },
];

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readRequiredFile(sourceDirectory, relativePath) {
  const absolutePath = path.join(sourceDirectory, relativePath);
  const stat = await fs.lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`UXP_RUNTIME_FILE_INVALID:${relativePath}`);
  }
  return fs.readFile(absolutePath);
}

function normalizeRuntimeFile(relativePath, value) {
  // Les huit ressources UXP sont du texte UTF-8. Un checkout Windows CRLF
  // doit produire les mêmes octets de paquet que le checkout LF de la release.
  const text = value.toString('utf8').replace(/\r\n/g, '\n');
  // UXP Developer Tool retire le saut de ligne final du manifeste lors de la
  // création du CCX. Le staging reproduit cette canonicalisation afin que ses
  // empreintes décrivent exactement les octets du paquet Adobe final.
  return Buffer.from(relativePath === 'manifest.json' ? text.replace(/\n$/, '') : text, 'utf8');
}

function validateManifest(manifest) {
  if (manifest.manifestVersion !== 5) throw new Error('UXP_MANIFEST_VERSION_INVALID');
  if (manifest.host?.app !== 'ID') throw new Error('UXP_HOST_INVALID');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.host?.minVersion ?? '')) throw new Error('UXP_HOST_VERSION_INVALID');
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(manifest.id ?? '')) throw new Error('UXP_PLUGIN_ID_INVALID');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) throw new Error('UXP_PLUGIN_VERSION_INVALID');
  const networkDomains = manifest.requiredPermissions?.network?.domains;
  if (networkDomains !== 'all') {
    throw new Error('UXP_NETWORK_PERMISSION_INVALID');
  }
  if (manifest.requiredPermissions?.clipboard !== 'read') throw new Error('UXP_CLIPBOARD_PERMISSION_INVALID');
  if (manifest.requiredPermissions?.localFileSystem !== 'fullAccess') throw new Error('UXP_FILES_PERMISSION_INVALID');
  if (manifest.requiredPermissions?.allowCodeGenerationFromStrings !== true) throw new Error('UXP_CODE_PERMISSION_INVALID');
  if (manifest.requiredPermissions?.launchProcess !== undefined) throw new Error('UXP_PROCESS_PERMISSION_FORBIDDEN');
}

export async function prepareUxpPackage({ sourceDirectory, outputDirectory, allowedOutputRoot }) {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  const allowedRoot = path.resolve(allowedOutputRoot);
  if (!isInside(allowedRoot, output)) throw new Error('UXP_OUTPUT_OUTSIDE_ALLOWED_ROOT');

  const packageJson = JSON.parse(await fs.readFile(path.resolve(source, '..', 'package.json'), 'utf8'));
  const buffers = new Map();
  for (const relativePath of UXP_RUNTIME_FILES) {
    const value = normalizeRuntimeFile(relativePath, await readRequiredFile(source, relativePath));
    const text = value.toString('utf8');
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.pattern.test(relativePath) || rule.pattern.test(text)) {
        throw new Error(`UXP_FORBIDDEN_CONTENT:${rule.code}:${relativePath}`);
      }
    }
    buffers.set(relativePath, value);
  }

  const manifest = JSON.parse(buffers.get('manifest.json').toString('utf8'));
  validateManifest(manifest);
  if (manifest.version !== packageJson.version) throw new Error('UXP_VERSION_MISMATCH');

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const fileHashes = {};
  for (const [relativePath, value] of buffers) {
    const target = path.join(output, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, { flag: 'wx' });
    fileHashes[relativePath] = sha256(value);
  }

  const entries = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`UXP_STAGING_SYMLINK_FORBIDDEN:${entry.name}`);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) entries.push(path.relative(output, absolutePath).split(path.sep).join('/'));
      else throw new Error(`UXP_STAGING_ENTRY_INVALID:${entry.name}`);
    }
  }
  await walk(output);
  entries.sort();
  const expected = [...UXP_RUNTIME_FILES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error('UXP_STAGING_CONTENT_MISMATCH');

  const fingerprint = sha256(expected.map((relativePath) => `${relativePath}\0${fileHashes[relativePath]}`).join('\n'));
  return {
    pluginId: manifest.id,
    version: manifest.version,
    host: manifest.host,
    files: expected,
    fileHashes,
    fingerprint,
    outputDirectory: output,
  };
}
