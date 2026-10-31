import crypto from 'node:crypto';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function contractFor(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    route: tool._meta?.route ?? 'unknown',
    mutatesDocument: tool._meta?.mutatesDocument === true,
    pathRules: tool._meta?.pathRules ?? [],
  };
}

function summaryFor(contract) {
  return {
    name: contract.name,
    route: contract.route,
    readOnly: contract.annotations?.readOnlyHint === true,
    destructive: contract.annotations?.destructiveHint === true,
    openWorld: contract.annotations?.openWorldHint === true,
    mutatesDocument: contract.mutatesDocument,
    schemaHash: hash(contract.inputSchema),
  };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildRegistryManifest(tools, { includeTools = false } = {}) {
  const contracts = tools.map(contractFor).sort((left, right) => left.name.localeCompare(right.name));
  const summaries = contracts.map(summaryFor);
  const manifest = {
    schemaVersion: 1,
    registryHash: hash({ schemaVersion: 1, contracts }),
    toolCount: contracts.length,
    routes: countBy(summaries, 'route'),
    capabilities: {
      readOnly: summaries.filter((tool) => tool.readOnly).length,
      destructive: summaries.filter((tool) => tool.destructive).length,
      mutating: summaries.filter((tool) => tool.mutatesDocument).length,
      openWorld: summaries.filter((tool) => tool.openWorld).length,
    },
  };
  if (includeTools) manifest.tools = summaries;
  return manifest;
}
