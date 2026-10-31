import { readFileSync } from 'node:fs';

// Source unique de la version : package.json, copié avec src/ dans le runtime par install.ps1.
// Le serveur MCP l'annonce et le pont exige la même version de l'extension UXP (manifeste aligné, vérifié par les tests).
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;
