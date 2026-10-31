# Consignes de développement

- Cibler Adobe InDesign 2026 et Node.js 24 LTS.
- Le protocole privilégie les commandes structurées et validées, tout en conservant une commande UXP complète pour les besoins avancés.
- L'exécution UXP libre exige une authentification mutuelle réussie, une raison explicite, une révision de document attendue et une sauvegarde de sécurité fraîche. Elle n'est jamais accessible par HTTP.
- Le serveur réseau écoute uniquement sur `127.0.0.1`, impose l'authentification mutuelle et n'accepte qu'une extension UXP à la fois.
- Les secrets ne sont jamais écrits dans le dépôt, les journaux ou la configuration Codex. Leur source persistante reste `%OneDrive%\Documents\NexusSecure`.
- Les sauvegardes, audits et états d'exécution restent dans `~\.nexus\indesign-mcp-secure\private`
  (runtime local hors OneDrive, le serveur refuse OneDrive), protégés par ACL et hors Git ; ils ne sont
  jamais synchronisés dans `NexusSecure`.
- Toute lecture ou écriture effectuée par un outil structuré passe par la politique de chemins autorisés. `execute_uxp` conserve volontairement les permissions complètes du manifeste et n'est pas un bac à sable.
- Les journaux ne contiennent ni texte de document, ni chemin complet, ni secret.
- Les opérations destructrices restent explicitement identifiées dans les métadonnées MCP et déclenchent une sauvegarde préalable.
- Le serveur MCP n'accepte de démarrer en production que depuis une chaîne de processus d'agent autorisée (Codex par défaut, Claude Code via le plugin `nexus-indesign@nexus` de NexusClaude) : nom, dossier et signature vérifiés ; un mode de test séparé et explicite couvre les contrôles automatisés.
- Le profil d'outils `core` (par défaut) n'expose que le noyau sécurisé, dont `run_layout_script`, voie normale d'écriture (sauvegarde, script et aperçu en un passage) ; toute nouvelle commande unitaire va dans le profil `full`. Le skill `codex-plugin\skills\indesign-studio` sert à Codex et à Claude Code : ne pas y écrire de consigne propre à un seul agent.
- Conserver le générateur COM/JSX existant comme solution reproductible ; le MCP sert aux inspections et corrections ciblées.
- Après une modification significative : mettre à jour `CHANGELOG.md`, exécuter `test.ps1` (jamais `npm ci` dans OneDrive), `npm audit --audit-level=high` depuis le runtime, vérifier le diff et l'absence de secret, puis committer en français.
