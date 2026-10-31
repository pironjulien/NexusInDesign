# Workflows de mise en page

Cette couche compose les commandes UXP structurées déjà authentifiées. Elle n’ajoute aucun serveur, aucun transport HTTP et aucune exécution libre.

## Outils

- `analyze_layout` capture la géométrie, les pages, les objets, les liens, les images, les polices, les calques, les nuances et les styles. Le serveur calcule une empreinte SHA-256 stable et applique le contrat transmis.
- `compare_layout_snapshot` recalcule cette empreinte pour vérifier un aller-retour sans comparer les identifiants, noms de fichiers, chemins, révisions ou dates volatiles.
- `create_working_copy` crée une sauvegarde INDD vérifiée, la copie vers la cible autorisée, ouvre cette copie et relit le jeton d’état de la source. La source doit être strictement inchangée.
- `preview_layout` exporte les pages en PNG, vérifie chaque fichier et confirme que l’empreinte du document n’a pas changé pendant l’export.
- `finalize_layout` bloque l’export en présence d’une erreur contractuelle ou d’une entrée dans les résultats agrégés officiels du contrôle Adobe, puis vérifie la structure du PDF produit.

## Contrat de mise en page

Les règles génériques sont prudentes : diagnostic complet, aucun débordement de texte, aucun lien ou police manquants. Les seuils dépendants du support ne sont jamais inventés et doivent être fournis explicitement : résolution minimale, marges, formats autorisés, polices, styles, calques, nombre de pages, nombre de nuances ou tolérance hors page.

`maxItems` borne la réponse UXP. Si la limite est atteinte, le lint échoue par défaut avec `SNAPSHOT_TRUNCATED`; augmenter la limite ou désactiver explicitement `requireCompleteSnapshot` pour un simple diagnostic exploratoire.

## Garanties et limites

- Toutes les sorties restent soumises aux racines de chemins, à la protection d’écrasement, aux sauvegardes, au verrou interprocessus et au journal d’audit existants.
- L’empreinte mesure l’état de mise en page capturé, pas l’identité binaire du fichier INDD.
- Le lint complète le contrôle Adobe mais ne le remplace pas. La finalisation renvoie le rapport Adobe brut avec le diagnostic contractuel.
- Une issue inconnue de l’hôte conserve la sortie partielle et exige la réconciliation habituelle avant toute nouvelle mutation.
