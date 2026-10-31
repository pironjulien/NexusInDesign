# Contribution

Ce dépôt public est une version maintenue et durcie du projet communautaire
`theloniuser/indesign-uxp-server`.

## Environnement

- Windows 11 ;
- Node.js 24 ;
- Adobe InDesign 2026 ;
- UXP Developer Tool.

## Avant toute modification

1. Synchroniser `main` ; examiner le dépôt amont (voir `NOTICE.md`) sans fusion automatique.
2. Ne jamais ajouter de document métier, de secret, de jeton ou de sauvegarde INDD.
3. Conserver les outils hérités du profil `full` (112 `legacy-uxp` et 3 `legacy-local`) et `execute_uxp`, sauf décision explicite.
4. Maintenir l'authentification, l'anti-rejeu, les révisions et les sauvegardes.
5. Ajouter un test qui échoue réellement avant de corriger un défaut de protocole.

## Vérifications obligatoires

Jamais de `node_modules` dans le dossier OneDrive : `install.ps1` installe le runtime et les dépendances dans
`~\.nexus\indesign-mcp-secure`, `test.ps1` lance `npm test` dans une copie miroir sous `%LOCALAPPDATA%` puis
`gitleaks`.

```powershell
.\install.ps1
.\test.ps1
.\scripts\Test-Installation.ps1
git diff --check
```

`npm audit --audit-level=high` se lance depuis `~\.nexus\indesign-mcp-secure`.

Une modification du DOM UXP doit aussi être essayée dans un vrai document de
test InDesign. Une simulation du WebSocket ne prouve pas la compatibilité du DOM.

## Version

La version du serveur et celle du plugin UXP se montent **ensemble** : le pont exige que l'extension annonce
exactement la version de `package.json` (`src/version.js`). Une nouvelle version touche donc, dans le même commit :

- `package.json` (et `package-lock.json`) ;
- `plugin/manifest.json`, `plugin/index.js` (`PLUGIN_VERSION`), `plugin/commands.js` (`pluginVersion` et le
  libellé du panneau), `plugin/index.html` ;
- le manifeste `codex-plugin/.codex-plugin/plugin.json`, régénéré par `scripts/Sync-CodexPlugin.ps1`.

Ces fichiers `plugin/` ne changent qu'avec un nouveau CCX : entre deux versions, ils restent identiques au CCX
publié (son empreinte est vérifiée par `npm run release:verify`). Les tests lisent la version depuis
`src/version.js`, jamais en dur.

## Publication

- mettre à jour `CHANGELOG.md` ;
- examiner le diff et rechercher les secrets ;
- utiliser un message de commit en anglais ;
- pousser uniquement vers `origin` (`pironjulien/NexusInDesign`, public) : aucune donnée personnelle ni
  professionnelle, garde gitleaks au pre-push ;
- vérifier le CCX officiel avec `npm run release:verify` ;
- publier l’asset seulement depuis une branche propre et déjà poussée avec
  `npm run release:publish`.
