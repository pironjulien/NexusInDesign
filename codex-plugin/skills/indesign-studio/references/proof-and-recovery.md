# Preuve, reprise et restauration

## Capturer l'état avant modification

Conserver sans exposer de contenu sensible :

- `documentId`, `revision` et `stateToken` ;
- empreinte d'`analyze_layout` et périmètre du contrat ;
- état des liens, polices, images, débordements et préflight ;
- copie de travail ou identifiant de sauvegarde vérifiée ;
- pages et doubles pages témoins rendues.

## Tenir une preuve de mutation

Pour chaque mutation, relever l'outil, l'objet ciblé, la révision attendue, la nouvelle révision, la sauvegarde créée et le contrôle effectué. Ne jamais consigner le texte métier, un chemin complet sensible, un secret ou du code libre.

Relire immédiatement l'objet ou le document. Une réponse d'envoi n'est pas une preuve d'effet.

## Reprendre après une issue inconnue

1. Ne lancer aucune nouvelle mutation.
2. Interroger `silent_operation_status` ou `bridge_operation_status` avec l'identifiant réel.
3. Si le statut reste `pending`, fermer complètement InDesign puis le relancer. Le journal compare le PID et l’heure de création : garder l’ancien processus ouvert ou seulement fermer l’application sans la relancer ne suffit pas. Cette barrière empêche un code UXP asynchrone suspendu de reprendre après la libération du verrou.
4. Utiliser `silent_reconcile_unknown_operation` si l'issue reste inconnue. Une réponse tardive déjà marquée terminée permet la réconciliation sans redémarrage, car le code a rendu son résultat.
5. Relire document, révision et jeton.
6. Continuer uniquement si l'état réel et la sauvegarde sont déterminés.

## Limiter les cycles de correction

- Cycle 1 : appliquer la correction minimale fondée sur le rendu.
- Cycle 2 : changer d'hypothèse ou de niveau, par exemple corriger le style plutôt que l'objet.
- Cycle 3 : tenter une dernière correction mesurable.
- Après le troisième échec : arrêter cette voie, restaurer la dernière base saine ou reconstruire la partie concernée dans la copie de travail. Expliquer la cause et l'état conservé.

## Restaurer ou reconstruire

- Utiliser `silent_restore_backup` pour une sauvegarde du canal silencieux, ou `restore_safety_backup` pour une sauvegarde du canal plugin.
- Vérifier l'identité et l'empreinte de la sauvegarde avant restauration.
- Relire le document restauré et obtenir sa nouvelle révision monotone.
- Reconstruire à partir d'une copie saine si la restauration ne suffit pas ; ne pas empiler des correctifs sur un état incohérent.

## Prouver la sortie

Exiger selon le livrable :

- inspection structurelle après la dernière mutation ;
- rendu réel d'au moins une page et d'une double page pour les documents en vis-à-vis ;
- critique visuelle consignée et corrections reliées aux observations ;
- préflight Adobe sans erreur bloquante ;
- artefact final existant, lisible et rendu avec type, pages et dimensions attendus ;
- nouvelle empreinte `analyze_layout` prise après la dernière modification intentionnelle, puis `compare_layout_snapshot` réussi contre cette empreinte pour prouver l'absence de dérive pendant l'aller-retour ;
- chemin final autorisé et révision livrée.

Présenter la remise en trois états : **terminé et prouvé**, **non terminé**, **non vérifié**. Ne jamais transformer une absence de preuve en succès.
