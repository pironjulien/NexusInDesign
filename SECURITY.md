# Sécurité

## Signaler une vulnérabilité

Signaler toute faille en privé par le
[signalement privé de vulnérabilités GitHub](https://github.com/pironjulien/NexusInDesign/security/advisories/new),
jamais dans un ticket public. Première réponse sous 3 jours ; une faille confirmée est corrigée dans une nouvelle
version, puis publiée dans un avis de sécurité GitHub. Seule la dernière version est prise en charge.

## Frontière de confiance

Codex ou Claude Code lance le serveur par MCP STDIO. Aucune API HTTP n’est exposée. Le serveur
Node écoute uniquement sur `127.0.0.1:33171` pour recevoir le client WebSocket
du plugin UXP et les autres processus MCP locaux de l’agent ; le canal COM silencieux
n’ouvre aucun port. Le premier processus devient courtier. Les suivants
vérifient son PID et réalisent une authentification mutuelle HMAC. Le courtier
retrouve en retour le PID de l’extrémité TCP cliente avec `netstat`, puis exige
dans sa chaîne un exécutable d’agent signé et explicitement autorisé. Chaque requête et
réponse est signée avec un nonce anti-rejeu ; après 10 000 requêtes, la connexion
est renouvelée au lieu d’oublier un ancien nonce. Tous restent soumis à la même
FIFO et au même mutex InDesign.

Le démarrage exige un agent autorisé dans la chaîne d’ancêtres : nom, dossier
et signature sont vérifiés. Par défaut, `codex.exe` signé par OpenAI ; le plugin
Claude `nexus-indesign@nexus` déclare `claude.exe` signé par Anthropic
(`INDESIGN_MCP_ALLOWED_PARENT_NAMES`, `INDESIGN_MCP_ALLOWED_PARENT_SIGNERS`,
`INDESIGN_MCP_ALLOWED_PARENT_PATHS`). Le plugin et le serveur s’authentifient mutuellement par
HMAC avec deux nonces ; chaque commande reçoit un nonce et une signature propres.

Seul le secret reste sous
`%OneDrive%\Documents\NexusSecure\InDesignMCP`. Sauvegardes, audit et journaux de
reprise restent sous `~\.nexus\indesign-mcp-secure\private`, hors OneDrive et hors Git
(le serveur refuse un stockage privé sous OneDrive).
Les deux emplacements ont une DACL limitée à l’utilisateur Windows courant et
`SYSTEM`. La valeur du secret n’est présente ni dans Git, ni dans
`config.toml`, ni dans les logs.

## Deux canaux indépendants

Le canal silencieux écrit un `.idjs` et son résultat dans une session privée à
nom aléatoire. Le code n’apparaît jamais dans la ligne de commande. Chaque source
générée est analysée par le moteur JavaScript avant envoi, ce qui bloque une
erreur de génération avant qu’Adobe puisse ouvrir une boîte modale.

Les opérations passent par la FIFO du courtier propriétaire, un mutex Windows
pour les appels COM et un verrou de mutation persistant partagé avec le plugin.
Le verrou n’est jamais libéré lorsqu’une issue demande encore une inspection.
Si le propriétaire disparaît, l’acquisition atomique du port élit un seul
successeur ; une commande interrompue conserve son identifiant et son état
inconnu.

Une issue silencieuse conserve script, résultat et métadonnées pendant 24 heures.
Une issue plugin conserve un journal JSONL privé minimal pendant la même durée.
Ce journal ne contient que l’identifiant, le nom de commande, l’état et les dates,
jamais les arguments ou le contenu. Les deux canaux restent donc réconciliables
après redémarrage complet du MCP.

## État et sauvegardes

La révision applicative et un `stateToken` 64 bits sont revérifiés directement
dans InDesign juste avant une mutation. L’empreinte couvre les préférences du
document, pages, marges, guides, histoires, tableaux, objets, géométrie, liens,
nuances, dégradés et styles. C’est un détecteur de dérive à large couverture,
pas une preuve cryptographique absolue du fichier INDD.

Tout vrai mutateur structuré crée une sauvegarde préalable. Le code UXP libre
sauvegarde tous les documents ouverts, car il peut accéder à `app`. Chaque copie
silencieuse possède des métadonnées liées au `documentId`, à la révision et au
`stateToken`, avec taille et SHA-256. Une restauration refuse une copie altérée
ou provenant d’un autre document, sauvegarde d’abord l’état courant et ouvre une
nouvelle copie de travail ; l’original de sauvegarde reste immuable.

## Code UXP complet

Les trois outils libres sont annotés `openWorldHint=true` :
`execute_indesign_code`, `execute_uxp` et `execute_uxp_silent`. Le manifeste
utilise la permission réseau UXP compatible avec InDesign 21.4.1.4, mais le code
du plugin fige son transport sur `ws://127.0.0.1:33171`. Il conserve l’accès
complet aux fichiers et la génération de code, sans permission `launchProcess`.

Cette puissance est volontaire. Les garde-fous sont l’appelant signé (Codex ou Claude Code),
l’authentification, le motif, les états attendus, les sauvegardes, les racines de
chemins pour les outils structurés et l’absence de contenu dans l’audit. Le code
libre n’est pas un bac à sable et ne doit jamais être dérivé automatiquement
d’une source non fiable.

## Sorties et vérifications

Une cible existante est refusée sans `overwrite=true`. Si l’écrasement est
autorisé, la cible reçoit d’abord une copie privée. Une issue inconnue conserve
la sortie partielle au lieu de la supprimer pendant qu’InDesign pourrait encore
l’écrire.

- PDF : en-tête, objets, xref, `startxref` et marque de fin ;
- PNG : structure des chunks, ordre, CRC, flux décompressable, filtres et
  dimensions ;
- IDML : vrai ZIP, mimetype, `designmap.xml`, CRC et chemins sûrs ;
- INDD : signature binaire et taille minimale ;
- package : parcours récursif sans lien symbolique et contenu utile ;
- PNG multipages : chemins déclarés, nombre exact et validation de chaque image.

Ces contrôles détectent les faux succès et fichiers tronqués. Ils ne remplacent
pas un interpréteur PDF complet, une comparaison visuelle pixel à pixel, une
validation sémantique complète de l’IDML ou l’analyse du format propriétaire INDD.
Un package non vide ne prouve pas à lui seul que toutes les polices et tous les
liens attendus sont présents.

Sous Windows, les liens symboliques de fichiers peuvent exiger le mode
développeur ou une élévation. La vérification automatisée utilise donc une
jonction de dossier, point de réanalyse réellement créable sans privilège, et
prouve que l’artefact est refusé avec `ARTIFACT_SYMBOLIC_LINK`.

## Audit et confidentialité

L’événement de début doit être écrit avant l’envoi à InDesign. Si cette écriture
échoue, la commande est bloquée. Une panne du seul événement final ajoute un
avertissement sans répéter la mutation. Le motif est remplacé par son SHA-256 ;
code, texte, chemins et arguments libres ne sont jamais journalisés.

## Limites confirmées

- `UndoModes.ENTIRE_SCRIPT` n’offre pas un historique UXP fiable dans le scénario
  `doScript` testé ; la restauration INDD est la garantie réelle.
- Une copie INDD n’annule ni une requête réseau ni une écriture externe.
- Un programme malveillant déjà exécuté sous le même compte Windows reste dans
  la même frontière de confiance ; une DACL n’est pas un bac à sable système.
- Le plugin doit être chargé et appairé pour les commandes structurées unitaires
  de modification, les exports IDML et images et `execute_uxp`. Sans lui, le canal
  silencieux couvre les diagnostics locaux, l’ouverture et la création de
  document, les lectures, les audits, le contrôle prépresse, `run_layout_script`,
  les exports PDF et PNG, `preview_layout`, `finalize_layout` et
  `package_document`.
- L’empreinte de mise en page contrôle la structure capturée, pas l’identité
  binaire du fichier ni son rendu visuel.

Ne publier aucun document, secret, sauvegarde ou journal interne dans un ticket.
