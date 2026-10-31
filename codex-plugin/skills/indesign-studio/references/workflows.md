# Parcours métier

Choisir un seul parcours principal, puis appliquer le workflow obligatoire de `SKILL.md`.

## Détecter une chaîne de production existante

Avant toute création, reconstruction, déclinaison ou correction :

1. Lire les consignes du projet et inventorier ses scripts, commandes de paquet, moteurs InDesign, configurations, données, tests et validations versionnés.
2. Vérifier que le runner identifié décrit des entrées et sorties réelles, protège les fichiers existants et produit un résultat contrôlable. Ne jamais traiter un script téléchargé, généré à la volée ou non versionné comme une chaîne de confiance.
3. Si ce runner couvre le livrable ou la correction, le conserver comme source de vérité. Pour une correction locale non couverte, écrire un script UXP borné et relisible, l'enregistrer dans le projet s'il doit resservir, et le passer à `run_layout_script` plutôt que d'enchaîner des commandes unitaires. Regarder ensuite l'aperçu, préflighter et contrôler le résultat final.
4. Pour un défaut répété ou structurel, modifier le moteur, la configuration ou les données, puis régénérer. Ne pas accumuler dans l'INDD des corrections manuelles que la prochaine génération effacerait.
5. Hors runner, toute écriture passe par `run_layout_script` : contrôle d'état, sauvegarde, script et aperçu en un seul passage.

Les commandes `legacy-uxp` ne sont exposées que dans le profil `full` : un filet de compatibilité, pas le parcours normal. Une propriété inconnue se vérifie avec `search_official_dom` avant d'écrire le script.

Pour un premier appairage ou un renouvellement, utiliser `bridge_open_pairing_window` depuis la tâche active. Si elle est cliente, le courtier transmet la demande au propriétaire du listener. Communiquer le code temporaire retourné, le faire saisir dans le panneau, puis demander un seul clic visible. Ne pas inscrire ce code dans le compte rendu et ne jamais lancer un serveur manuel avec l’ancien mode `--pair` contre le même port.

## Inspecter ou auditer

1. Rester en lecture seule.
2. Relever document, révision, structure, pages, gabarits, calques, styles, liens, polices, images et débordements.
3. Lancer `analyze_layout`, puis `preflight_document` si InDesign est disponible.
4. Exporter une page et, si nécessaire, une double page pour vérifier le rendu réel.
5. Classer les constats par impact : bloquant, important, amélioration.

## Corriger un document existant

1. Créer une copie de travail ou une sauvegarde datée vérifiée et conserver l'empreinte de la source.
2. Déterminer si le document provient d'un runner versionné et retrouver, si elles existent, les empreintes ou métadonnées qui relient le résultat au moteur, à la configuration et aux données.
3. Relier chaque défaut à un objet, un style, un gabarit, une préférence ou une source de génération précise.
4. Corriger le système avant les occurrences : moteur, configuration, données, style ou gabarit d'abord, exception locale ensuite. Régénérer lorsqu'une correction appartient à la chaîne de production.
5. Pour une exception locale, un script `run_layout_script` borné : lecture préalable, nombre d'occurrences attendu, écriture, valeur de contrôle renvoyée, aperçu des pages touchées. Regrouper les petites corrections dans un même script.
6. Rendre avec `previewPages` les pages affectées et une page témoin non affectée pour détecter une régression.
7. Limiter la boucle à trois corrections ciblées avant rollback ou reconstruction.
8. Une fois le lot terminé, utiliser le MCP pour l'audit InDesign final, le préflight, les débordements, les ressources, le rendu des pages témoins et la comparaison d'empreinte.

## Créer une mise en page

1. Exiger les contenus, assets, contraintes de marque et spécifications de sortie réels. Ne pas remplir les manques avec du faux contenu.
2. Appliquer d'abord le parcours « Détecter une chaîne de production existante ».
3. Définir format, fond perdu, marges, colonnes, gouttières, grille de ligne de base et pages en vis-à-vis.
4. Construire nuances, styles et gabarits avant de peupler les pages.
5. Créer avec le runner une page ou double page pilote lorsqu'il sait produire un échantillon ; sinon limiter le premier passage à des pages témoins. Les rendre et les faire valider visuellement avant de décliner.
6. Produire le document complet avec le runner lorsqu'il existe, puis contrôler régularité et exceptions avec le MCP.
7. Reporter toute correction systémique dans le moteur, la configuration ou les données et régénérer avant la validation finale.

## Adapter un template

1. Ne jamais écraser le template. Ouvrir une copie de travail.
2. Inventorier formats, gabarits, grilles, calques, styles, nuances et emplacements réservés.
3. Extraire la logique visuelle sans supposer que chaque surcharge locale est intentionnelle.
4. Mapper chaque contenu réel vers un style et un emplacement existants ; créer un nouveau style seulement si le système ne couvre pas le besoin.
5. Tester pages courtes, longues et extrêmes avant la production complète.

## Importer un document Word

1. Vérifier le fichier DOCX réel et obtenir le mapping attendu entre styles Word et styles InDesign.
2. Préparer la copie de travail, les styles de destination et le bloc ou flux de texte cible.
3. Utiliser l'outil structuré de placement compatible, sans copier-coller ni réécrire le contenu.
4. Contrôler titres, paragraphes, listes, tableaux, notes, italiques, caractères spéciaux, sauts et images importées.
5. Corriger le mapping de styles plutôt que chaque paragraphe. Signaler toute fonction Word non conservée.

## Réaliser une fusion de données

1. Demander un accord explicite avant toute fusion (script UXP sur l'objet `DataMerge` du document, ou `data_merge` du profil `full`). Nommer le fichier de données, les champs utilisés, le template cible et la sortie prévue.
2. Valider les en-têtes, encodage, séparateurs, valeurs vides, doublons et chemins d'images sans modifier silencieusement les données.
3. Vérifier que chaque champ correspond à un emplacement réel dans une copie du template.
4. Fusionner d'abord un échantillon représentatif autorisé. Contrôler visuellement les valeurs courtes, longues, vides et les images.
5. Lancer la fusion complète seulement après validation de l'échantillon. Rechercher débordements, pages inutiles, liens cassés et répétitions.

## Utiliser Adobe cloud

1. Demander un accord explicite avant toute connexion, ouverture ou envoi vers un service Adobe cloud.
2. Expliquer quelles données quittent la machine, pour quelle fonction et avec quelle sortie attendue.
3. Ne transmettre que les fichiers approuvés et nécessaires. Ne jamais inclure un secret ou un asset hors périmètre.
4. Vérifier localement le résultat rapatrié avant de l'intégrer au document de travail.

## Préflighter et exporter

1. Figer la révision à livrer et relire les ressources.
2. Corriger polices absentes, liens manquants, résolution insuffisante, débordements, couleurs ou fonds perdus selon le cahier des charges.
3. Lancer `preflight_document` avec le profil demandé.
4. Si un runner versionné possède déjà la production et les exports, l'utiliser pour conserver la reproductibilité, puis vérifier ses artefacts avec le MCP. Sinon, utiliser `finalize_layout` pour le PDF final, ou un export structuré adapté pour PNG, IDML, EPUB ou assemblage.
5. Rendre et inspecter l'artefact final, puis prouver l'aller-retour avec `compare_layout_snapshot`.
