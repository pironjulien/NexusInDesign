import crypto from 'node:crypto';
import fs from 'node:fs';

const INDEX_URL = new URL('../reference/indesign-dom-paths.xml', import.meta.url);
const SOURCE_SHA256 = 'c1b0d48666943c69847556a26e52b13f3d2a43b7b0efa410802e2c71c0a32331';
const SOURCE = Object.freeze({
  repository: 'https://github.com/AdobeDocs/uxp-indesign',
  commit: 'ba9d36134a4c2ee72dc03e16bbac3144e1263327',
  file: 'indesign-dom-paths.xml',
  license: 'Apache-2.0',
  sha256: SOURCE_SHA256,
});

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
}

function normalized(value) {
  return String(value).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function parseIndex() {
  const source = fs.readFileSync(INDEX_URL);
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  if (digest !== SOURCE_SHA256) throw new Error('L’index DOM Adobe embarqué ne correspond pas à son empreinte officielle épinglée.');
  const xml = source.toString('utf8');
  const entries = [];
  const seen = new Set();
  const pattern = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<\/url>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const url = new URL(decodeXml(match[1]));
    if (url.protocol !== 'https:' || url.hostname !== 'developer.adobe.com' || url.username || url.password || url.search || url.hash) {
      throw new Error('L’index DOM Adobe contient une URL hors du domaine officiel autorisé.');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      (parts.length === 3 || parts.length === 4)
      && parts[0] === 'indesign'
      && parts[1] === 'dom'
      && parts[2] === 'api'
      && (parts.length === 3 || parts[3].length === 1)
    ) continue;
    if (parts.length !== 5 || parts[0] !== 'indesign' || parts[1] !== 'dom' || parts[2] !== 'api' || parts[3].length !== 1) {
      throw new Error('L’index DOM Adobe contient un chemin inattendu.');
    }
    const name = decodeURIComponent(parts[4]);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || seen.has(name.toLowerCase())) {
      throw new Error('L’index DOM Adobe contient un nom invalide ou dupliqué.');
    }
    seen.add(name.toLowerCase());
    entries.push(Object.freeze({ name, url: url.href, lastModified: match[2], normalizedName: normalized(name) }));
  }
  if (entries.length < 1_000) throw new Error('L’index DOM Adobe embarqué est incomplet.');
  return Object.freeze(entries.sort((left, right) => left.name.localeCompare(right.name)));
}

let cachedIndex;

function getIndex() {
  if (!cachedIndex) {
    const entries = parseIndex();
    cachedIndex = Object.freeze({
      entries,
      latestModification: entries.reduce((latest, entry) => entry.lastModified > latest ? entry.lastModified : latest, ''),
    });
  }
  return cachedIndex;
}

function score(entry, query, normalizedQuery) {
  const lowerName = entry.name.toLowerCase();
  if (lowerName === query.toLowerCase()) return 0;
  if (entry.normalizedName === normalizedQuery) return 1;
  if (entry.normalizedName.startsWith(normalizedQuery)) return 2;
  if (entry.normalizedName.includes(normalizedQuery)) return 3;
  return Number.POSITIVE_INFINITY;
}

export function officialDomIndexInfo() {
  const index = getIndex();
  return {
    source: SOURCE,
    entryCount: index.entries.length,
    latestModification: index.latestModification,
  };
}

export function searchOfficialDom(query, { limit = 10 } = {}) {
  const text = String(query).trim();
  const normalizedQuery = normalized(text);
  if (!normalizedQuery) return { ...officialDomIndexInfo(), query: text, matchCount: 0, matches: [] };
  const ranked = getIndex().entries
    .map((entry) => ({ entry, score: score(entry, text, normalizedQuery) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.entry.name.localeCompare(right.entry.name));
  return {
    ...officialDomIndexInfo(),
    query: text,
    matchCount: ranked.length,
    matches: ranked.slice(0, limit).map(({ entry }) => ({ name: entry.name, url: entry.url, lastModified: entry.lastModified })),
  };
}
