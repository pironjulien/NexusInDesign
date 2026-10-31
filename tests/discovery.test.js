import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/server/createApplication.js';
import { officialDomIndexInfo, searchOfficialDom } from '../src/discovery/AdobeDomIndex.js';
import { buildRegistryManifest } from '../src/discovery/registryManifest.js';
import { buildToolCatalog } from '../src/tools/catalog.js';
import { PACKAGE_VERSION } from '../src/version.js';

test('le manifeste du registre est stable, exhaustif et sensible aux contrats', () => {
  const tools = buildToolCatalog();
  const compact = buildRegistryManifest(tools);
  const reversed = buildRegistryManifest([...tools].reverse());
  assert.equal(compact.registryHash, reversed.registryHash);
  assert.equal(compact.toolCount, tools.length);
  assert.match(compact.registryHash, /^[a-f0-9]{64}$/);
  assert.ok(compact.routes.local >= 2);
  assert.equal(compact.tools, undefined);

  const detailed = buildRegistryManifest(tools, { includeTools: true });
  assert.equal(detailed.tools.length, tools.length);
  assert.ok(detailed.tools.every((tool) => /^[a-f0-9]{64}$/.test(tool.schemaHash)));

  const changed = tools.map((tool) => tool.name === 'ping'
    ? { ...tool, description: `${tool.description} contrat modifié` }
    : tool);
  assert.notEqual(buildRegistryManifest(changed).registryHash, compact.registryHash);
});

test('l’index local correspond à la source Adobe épinglée et classe les résultats utiles', () => {
  const info = officialDomIndexInfo();
  assert.equal(info.entryCount, 1078);
  assert.equal(info.source.repository, 'https://github.com/AdobeDocs/uxp-indesign');
  assert.equal(info.source.commit, 'ba9d36134a4c2ee72dc03e16bbac3144e1263327');
  assert.equal(info.source.sha256, 'c1b0d48666943c69847556a26e52b13f3d2a43b7b0efa410802e2c71c0a32331');
  assert.equal(info.latestModification, '2026-04-01');

  const exact = searchOfficialDom('Application', { limit: 3 });
  assert.equal(exact.matches[0].name, 'Application');
  assert.match(exact.matches[0].url, /^https:\/\/developer\.adobe\.com\/indesign\/dom\/api\//);
  const words = searchOfficialDom('text frame', { limit: 3 });
  assert.equal(words.matches[0].name, 'TextFrame');
  assert.equal(words.matches.length, 3);
  assert.deepEqual(searchOfficialDom('classe-qui-nexiste-pas').matches, []);
});

test('le doctor MCP reste local, ne divulgue aucun chemin et rend les capacités exploitables', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-discovery-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  const auditFile = path.join(secureRoot, 'audit', 'events.jsonl');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let silentStatusCalls = 0;
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_AUDIT_FILE: auditFile,
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '0',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({
      initialize: async () => {},
      status: async () => { silentStatusCalls += 1; return { version: '21.4' }; },
      close: async () => {},
    }),
    bridgeFactory: () => ({
      start: async () => {},
      status: () => ({ listening: true, connected: true, authenticated: true, pluginVersion: PACKAGE_VERSION, pairingActive: false }),
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'discovery-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  const doctor = await client.callTool({ name: 'indesign_doctor', arguments: { includeTools: true } });
  assert.equal(doctor.isError, undefined);
  assert.equal(doctor.structuredContent.status, 'ready');
  const registryCheck = doctor.structuredContent.checks.find((entry) => entry.id === 'tool-registry');
  assert.equal(registryCheck.toolProfile, 'core');
  assert.equal((await client.listTools()).tools.some((tool) => tool.name === 'create_ellipse'), false);
  const hidden = await client.callTool({ name: 'create_ellipse', arguments: {} });
  assert.equal(hidden.isError, true);
  assert.equal(doctor.structuredContent.hostProbePerformed, false);
  assert.equal(doctor.structuredContent.channels.plugin.usable, true);
  assert.equal(doctor.structuredContent.channels.silent.hostChecked, false);
  assert.equal(silentStatusCalls, 0);
  assert.equal(doctor.structuredContent.registry.tools.length, doctor.structuredContent.registry.toolCount);
  assert.ok(!JSON.stringify(doctor.structuredContent).includes(directory));

  const reference = await client.callTool({ name: 'search_official_dom', arguments: { query: 'Document', limit: 1 } });
  assert.equal(reference.structuredContent.matches[0].name, 'Document');
  assert.equal(reference.structuredContent.entryCount, 1078);
  const invalid = await client.callTool({ name: 'search_official_dom', arguments: { query: 'Document', limit: 0 } });
  assert.equal(invalid.isError, true);
});
