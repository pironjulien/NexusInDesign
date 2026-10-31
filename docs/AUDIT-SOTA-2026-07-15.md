# Audit SOTA InDesign + Codex — mise à jour du 17 juillet 2026

> **Archive.** Photographie de la version 3.2.2 au 17 juillet 2026, non tenue à jour. Chiffres, chemins et noms
> (« InDesign MCP Secure », `C:\Dev`) sont ceux de cette date ; l'état courant est dans `README.md` et
> `CHANGELOG.md`.

## Verdict

L’architecture cible est la bonne : un **skill** pour la méthode de studio, un
**plugin Codex** pour distribuer ce skill avec sa configuration, un **MCP local**
pour les actions contrôlées et une **extension UXP** pour l’exécution dans
InDesign. Aucun projet public examiné ne réunit à lui seul la même combinaison
de workflow visuel, copie de travail, verrou de révision, sauvegarde vérifiée,
reprise après issue inconnue, authentification mutuelle et stockage privé.

Les projets publics restent utiles : certains ont un catalogue plus large,
d’autres de meilleurs parcours de template ou de découverte DOM. Le choix SOTA
n’est donc pas de les copier entièrement, mais d’intégrer leurs bonnes idées
derrière les garanties locales.

Cet audit rassemble les recherches du 15 juillet et les preuves obtenues les
16 et 17 juillet 2026. Le plugin Codex et le CCX Adobe 3.2.2 sont installés et
activés. Après fermeture complète d’InDesign, le paquet persistant s’est
rechargé sans UXP Developer Tools, l’appairage a été conservé et le test de
connexion seule a confirmé une liaison MCP → UXP → InDesign authentifiée en
version 3.2.2, sans modifier de document.

## Architecture retenue

| Couche | Responsabilité | Preuve attendue |
|---|---|---|
| Skill `indesign-studio` | router inspection, correction, création, template, Word/data merge, critique et finalisation | workflow suivi, maximum trois cycles de correction, état final explicite |
| Plugin Codex `indesign-secure` | distribuer le skill et la configuration MCP | plugin présent et activé dans une nouvelle tâche Codex |
| Serveur MCP STDIO | valider outils, chemins, révisions, sauvegardes, file d’exécution et résultats | réponse structurée relue dans InDesign |
| Canal COM → UXP silencieux | ouvrir, lire, auditer et préflighter sans dépendre du panneau | `documentId`, `revision` et `stateToken` réels |
| Extension UXP HMAC | exécuter les mutations et exports qui exigent le runtime plugin | connexion authentifiée, nouvelle révision, sauvegarde et relecture |
| Export visuel | montrer la vérité de la mise en page | PNG/PDF réellement rendu et inspecté page par page |

### Le panneau n’est pas le centre du système

Le panneau UXP sert à l’appairage, à l’affichage de l’état et au diagnostic. Il
ne contient ni le raisonnement du skill, ni le catalogue MCP, ni la preuve du
document. Il n’a donc pas à être remis au premier plan pendant chaque action.

Le canal silencieux reste disponible sans panneau. Pour le canal plugin,
l’extension doit être chargée et connectée, mais la preuve reste l’état relu du
document, son aperçu exporté et le préflight. Une capture du panneau ne prouve
pas qu’une page a été correctement modifiée.

### Partage multi-tâche authentifié

Adobe n’accepte qu’une connexion UXP sur le port local contractuel. Plusieurs
tâches Codex lancent pourtant chacune leur processus MCP. Un seul processus
possède donc `127.0.0.1:33171`, puis sert de courtier aux autres processus Codex
sur ce même listener. Une instance secondaire ne lit ni ne reprend les journaux
du propriétaire avant d’avoir échoué à acquérir le port, puis elle effectue une
authentification mutuelle HMAC, vérifie le PID observé et signe chaque requête et
chaque réponse avec un nonce anti-rejeu. Réciproquement, le propriétaire associe
l’extrémité TCP au PID du client Windows puis vérifie que sa chaîne contient le
`codex.exe` signé et autorisé. Le secret seul ne suffit donc pas à ouvrir le
canal pair. Après 10 000 requêtes, la session se ferme et renouvelle son
authentification avant qu’un nonce ancien puisse devenir rejouable.

Le courtier ne supprime aucune protection : chaque tâche valide les entrées et
les chemins, toutes les commandes passent dans la file FIFO du propriétaire et
le mutex Windows commun reste l’unique écrivain InDesign. Si le propriétaire
disparaît, les clients élisent par acquisition atomique du port un seul nouveau
propriétaire ; les autres le rejoignent. Une commande interrompue conserve son
identifiant et reste soumise à inspection et réconciliation. `bridge_status` et
`indesign_doctor` distinguent les rôles `owner` et `client`, le listener possédé
et la session plugin utilisable, sans inventer d’état distant.

Le contrôle réel du 17 juillet retrouve le PID exact d’un client loopback créé
pour l’audit, puis identifie avec succès son ancêtre Codex signé. Les tests
hostiles couvrent aussi un mauvais secret, un mauvais PID propriétaire, un
client sans chaîne autorisée, une signature altérée, une mauvaise direction de
message, des clés de prototype, un nombre non fini et une charge trop profonde.

## Contrôle des recommandations Codex

Les documentations officielles confirment la séparation retenue :

- un [skill Codex](https://developers.openai.com/codex/concepts/customization#skills)
  contient un workflow réutilisable dans `SKILL.md`, avec chargement progressif ;
- un [plugin Codex](https://developers.openai.com/codex/plugins/build#plugin-structure)
  peut regrouper skills et configuration MCP, avec
  `.codex-plugin/plugin.json` comme point d’entrée ;
- le [Model Context Protocol](https://developers.openai.com/codex/mcp/) fournit
  les outils et actions externes réellement appelés par Codex ;
- après modification d’un plugin local, la documentation demande de mettre à
  jour la copie visée par le marketplace, de rafraîchir ou réinstaller le
  plugin, puis de le tester dans une nouvelle tâche.

Conséquence locale : `codex-plugin` est la source Git. Le script
`scripts/Sync-CodexPlugin.ps1` copie cette source sous le profil utilisateur,
génère `.mcp.json` avec les chemins de la machine et effectue un remplacement
atomique. Il ne transforme pas à lui seul la copie en cache Codex en validation
effective ; cette activation doit être vérifiée séparément.

## Contrôle des recommandations Adobe

### Manifeste et permissions

La documentation Adobe du
[manifeste UXP](https://developer.adobe.com/indesign/uxp/plugins/concepts/manifest/)
exige un manifeste v5, une version `major.minor.patch` et un `host.minVersion`
au format `x.y.z`. La source 3.2.2 utilise `19.0.0`.

Sur InDesign 21.4.1.4 testé, les entrées WebSocket locales précises, avec ou
sans port et barre finale, sont refusées avec `Manifest entry not found`. Le
repli fonctionnel observé est `domains: "all"`. Cette permission de l’hôte ne
modifie pas l’adresse du transport de l’extension, figée sur
`ws://127.0.0.1:33171`. Le serveur reste lié à `127.0.0.1`, exige l’origine UXP
`file://` et l’authentification mutuelle HMAC.

`fullAccess` et `allowCodeGenerationFromStrings` restent nécessaires aux
opérations UXP avancées ; le manifeste n’accorde pas `launchProcess`. Le bouton
de collage ajoute seulement `clipboard: "read"` et ne lit le presse-papiers
qu’après un clic explicite. Le code libre `execute_uxp` peut volontairement
utiliser les permissions complètes du manifeste et ne constitue pas un bac à
sable. Cette puissance est compensée par l’accès loopback, l’appairage
volontaire, l’authentification HMAC, les révisions attendues, les sauvegardes et
la politique de chemins du MCP.

### Runtime et DOM

Adobe distingue les
[scripts et plugins UXP](https://developer.adobe.com/indesign/uxp/introduction/next-steps/script-and-plugin/) :
un script est un fichier `.idjs`, tandis qu’un plugin contient manifeste, code
et éventuellement interface, puis se distribue en `.ccx`. Cette distinction
justifie le canal silencieux pour les opérations sans interface et l’extension
pour le canal persistant authentifié.

Adobe demande aussi de relever ensemble version hôte et version UXP avec
[`require('uxp').host` et `require('uxp').versions`](https://developer.adobe.com/indesign/uxp/resources/recipes/host-info/).
Enfin, la migration officielle rappelle que deux objets DOM Adobe ne doivent
pas être comparés avec `===` mais avec
[`equals()`](https://developer.adobe.com/indesign/uxp/resources/migration-guides/extendscript/#comparison-operators--and-).
Ces points sont des contrôles de compatibilité, notamment lorsque la version
InDesign installée est plus récente que les tableaux publics du changelog UXP.

Le préflight s’appuie sur l’API officielle
[`PreflightProcess`](https://developer.adobe.com/indesign/uxp/dom/api/p/preflight-process/),
qui expose notamment `waitForProcess`, `processResults` et
`aggregatedResults`.

### CCX Adobe 3.2.2 et référence déterministe

Adobe confirme qu’un
[CCX est une archive ZIP](https://developer.adobe.com/indesign/uxp/introduction/next-steps/distribution/packaging/)
et recommande UXP Developer Tool en l’absence d’exigence particulière. Ce
projet a précisément une exigence particulière : obtenir le même paquet à
partir des mêmes octets et pouvoir comparer chaque entrée au staging minimal.

La construction locale :

1. prépare exactement huit fichiers d’exécution ;
2. trie leurs chemins avec une comparaison ordinale ;
3. fixe chaque date ZIP au 1er janvier 1980 ;
4. refuse les reparse points et une destination placée dans la source ;
5. écrit d’abord un fichier temporaire, puis remplace la sortie ;
6. relit les huit entrées et compare leur SHA-256 au manifeste de staging.

Cette exception est adaptée à une distribution privée auditable. Pour publier
sur Adobe Marketplace, il faut suivre le portail et les
[options de distribution Adobe](https://developer.adobe.com/indesign/uxp/introduction/next-steps/distribution/distribution-options/),
puis tester le paquet installé comme l’exige Adobe.

## Sécurité et données privées

`%OneDrive%\Documents\NexusSecure\InDesignMCP` reste la source persistante du
secret, des sauvegardes et du journal d’audit. La configuration générée ne
contient que le chemin du secret. Les Documents OneDrive sont autorisés pour
les entrées et livrables, mais `NexusSecure` est ajouté à la liste de refus afin
qu’aucun outil de fichiers structuré ne puisse le lire ou l’écraser.

Les garanties locales restent :

- MCP lancé en STDIO depuis la chaîne Codex autorisée ;
- WebSocket limité à `127.0.0.1` et origine UXP `file://` ;
- appairage volontaire, double nonce, HMAC mutuel et anti-rejeu ;
- une seule extension UXP acceptée ;
- `revision` et `stateToken` relus juste avant mutation ;
- sauvegardes INDD vérifiées avant restauration ;
- audit sans secret, contenu de document, argument libre ou chemin métier
  complet ;
- DACL limitée à l’utilisateur courant et `SYSTEM`.

## Comparaison des dépôts GitHub

Les révisions ci-dessous ont été consultées en lecture seule. Aucun code
communautaire n’a été copié dans le projet.

| Projet et révision | Apport utile | Décision locale |
|---|---|---|
| [tomgond/indesign-agent `ab5e43d`](https://github.com/tomgond/indesign-agent/commit/ab5e43d84cac0f7c6e9afed5784f94923aa616f3) | orchestration inspecteur → planificateur → exécuteur → critique → préflight, copie de travail, previews, lint et rollback | reprendre la boucle de studio dans le skill ; ne pas reprendre son pont HTTP/WebSocket dont le jeton est optionnel |
| [nutriandrea/adobe-indesign-mcp `0c43963`](https://github.com/nutriandrea/adobe-indesign-mcp/commit/0c43963e0e496cb78acc3a4842730d6696353601) | 183 outils annoncés, forte couverture texte, tables, listes, effets, XML et dix skills spécialisés | garder comme référence de couverture ; ne pas remplacer HMAC, sauvegardes et reprise par un WebSocket sans authentification mutuelle et un jeton HTTP vide par défaut |
| [zhanglongxiao111/indesign-cli `25d9e62`](https://github.com/zhanglongxiao111/indesign-cli/commit/25d9e62af3893b88431cb6ddea77c2aecf064506) | découverte progressive du catalogue, domaines et schémas, tests E2E et protection multi-document | piste future : étudier une découverte progressive compatible Codex ; la version actuelle expose encore son catalogue MCP complet et conserve l’architecture MCP/UXP sécurisée |
| [MoebiusSt/indesign-scripting-mcp `275a0d1`](https://github.com/MoebiusSt/indesign-scripting-mcp/commit/275a0d1b4ffc6a852b2369aa5b70e99861c0452e) | base DOM SQLite et workflow inspecter → rechercher → exécuter → vérifier → rollback | intégrer le lookup officiel avant code libre ; conserver l’index Adobe épinglé et les protections de mutation locales |
| [theloniuser/indesign-uxp-server `b746240`](https://github.com/theloniuser/indesign-uxp-server/commit/b74624025e921331ebe0bfc2a8a27132415f130f) | socle UXP historique et large catalogue de commandes InDesign | conserver le socle maintenu, mais remplacer l’authentification facultative et l’absence de reprise sûre par les garanties de ce fork |

Le meilleur apport communautaire est la séparation des rôles et la critique
visuelle ; le principal différenciateur local reste la sécurité et la preuve
d’état réelle après chaque mutation.

## Skills et services Adobe existants

Le dépôt officiel
[adobe/skills `42ce10f`](https://github.com/adobe/skills/commit/42ce10fddeda2a77bb61a6d491db7b8cbb73927c)
fournit le bundle pour agents `adobe-for-creativity` 1.1.0, relié au MCP cloud
Adobe, et le skill
[`adobe-create-pdfs-from-data`](https://github.com/adobe/skills/tree/42ce10fddeda2a77bb61a6d491db7b8cbb73927c/plugins/creative-cloud/adobe-for-creativity/skills/adobe-create-pdfs-from-data).
Ce dernier orchestre une fusion CSV/TSV avec template INDD ou conversion PDF,
inspection IDML, mapping et accord utilisateur avant création des placeholders.

Ce service est complémentaire : il couvre une chaîne Adobe cloud et des URL
présignées, pas le pilotage local général et sécurisé du document InDesign
ouvert. Il ne doit pas être activé ou recevoir des fichiers sans accord
explicite de l’utilisateur.

Aucun skill InDesign général n’a été trouvé dans la collection publique
[openai/skills](https://github.com/openai/skills) consultée. Le skill local
`indesign-studio` comble cette lacune avec inspection, copie de travail,
direction artistique, import Word, fusion sous accord, rendu page/double page,
critique, maximum trois corrections, préflight et rollback.

La comparaison a aussi couvert les skills communautaires
[Flue InDesign](https://github.com/SFKislev/Flue/tree/main/skills/indesign),
[indesign-cli](https://github.com/zhanglongxiao111/indesign-cli/tree/master/skills/indesign-cli),
[InDesign MCP Operator](https://github.com/MoebiusSt/indesign-scripting-mcp/tree/main/claude-skills/indesign-mcp-operator)
et [AlterLab Layout Designer](https://github.com/AlterLab-IEU/AlterLab-FC-Skills/tree/main/skills/vcd/alterlab-vcd-layout-designer).
Ils apportent respectivement index API, templates, pièges DOM ou heuristiques de
grille, mais aucun ne réunit sécurité, preuve InDesign réelle et direction
artistique spécialisée. Le choix retenu est donc un seul skill orchestrateur,
complété par des références progressives pour les différents livrables, plutôt
que plusieurs skills concurrents ou un second transport vers InDesign.

## Adobe Exchange

La consultation interactive du catalogue
[Adobe Exchange filtré pour InDesign](https://exchange.adobe.com/apps/browse/cc?product=IDSN&sort=RELEVANCE)
le 15 juillet 2026 affichait 702 résultats. Les résultats visibles étaient
surtout spécialisés : traduction assistée, accessibilité, catalogues et
publication, connecteurs de données, recherche d’images et génération d’assets.
Par exemple, Adobe Exchange référence
[`Translation AIgent for InDesign`](https://exchange.adobe.com/apps/cc/15682e74/translation-aigency-for-indesign).

Aucun résultat observé ne remplaçait un contrôleur local général réunissant
skill Codex, MCP STDIO, UXP, verrou de révision, sauvegardes vérifiées et critique
visuelle. Ces plugins peuvent compléter un besoin métier précis, mais leur
installation doit être décidée séparément après contrôle éditeur, permissions,
licence, compatibilité InDesign 2026 et traitement des données.

## Résultats des portes d’acceptation

1. **Réussi — référence déterministe.** L’archive de contrôle 3.2.2 porte le
   SHA-256
   `29c7ec2654e39e2466f19b62dc3f9d59b510d259fa373951ef8c4ec9bdeea571`.
   Elle reste séparée du nom réservé au paquet officiel Adobe.
2. **Réussi — contenu Adobe.** Le CCX produit par UXP Developer Tool contient
   exactement les huit fichiers du staging, avec les huit empreintes attendues.
   Son SHA-256 est
   `e01f69e3fe9090144fc1a1869130e358de24976822552836becd4f84cd6c3b90` ;
   l’empreinte logique du staging est
   `c9e43c980fb3b6e3cc3d449b22a4b18e5a1218d230c39ed0e3a625dfdafdc908`.
3. **Réussi — Codex.** Le plugin personnel `indesign-secure` est installé et
   activé en version `3.2.2+codex.20260717184605`. Sa source de skill est
   validée et sa configuration exclut `NexusSecure`.
4. **Réussi — installation Adobe persistante.** Le CCX 3.2.2 a été installé
   par Adobe UPIA puis comparé au staging fichier par fichier. Après fermeture
   complète d’InDesign, il s’est rechargé sans UXP Developer Tools et a conservé
   l’appairage stocké dans `secureStorage`.
5. **Réussi — connexion réelle.** Le test `test:live:connection` a confirmé
   `pluginVersion: "3.2.2"` et `authenticated: true` sur InDesign 21.4.1.4,
   sans modifier les documents ouverts.
6. **Réussi — commandes modernes et historiques.** Le test réel a créé un A5,
   enregistré l’INDD, exporté PDF, IDML et PNG par les commandes structurées,
   puis PNG et JPEG par `export_images`. Les signatures et les rendus ont été
   relus avant fermeture du document jetable.
7. **Réussi — plusieurs documents.** Le diagnostic réel a maintenu un document
   leurre actif tout en ciblant un autre document par identifiant. Les chemins
   structuré et historique, la preuve DOM, la réconciliation et le retour à
   zéro document ont tous renvoyé `true`.
8. **Réussi — portes automatiques.** La vérification intégrée la plus récente a
   exécuté 301 tests : 301 réussites, aucun test ignoré, aucun échec et aucune
   vulnérabilité npm. Le point de réanalyse est vérifié avec une jonction Windows
   réellement créable sans élévation.

Un document récupéré, modifié ou non enregistré ne sert jamais de cible au test
réel et n’est jamais fermé pour valider une installation.
