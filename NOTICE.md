# Origine et attribution

Ce projet dérive de `theloniuser/indesign-uxp-server`, commit
`b74624025e921331ebe0bfc2a8a27132415f130f`, distribué sous licence MIT.

Le dépôt amont n’est pas configuré comme remote Git. Pour examiner ses
corrections, l’ajouter temporairement (`git remote add upstream …`), les
intégrer sélectivement, puis le retirer.

Cette version sécurise la passerelle avec une authentification mutuelle, une
restriction de l'appelant aux agents signés autorisés (Codex, Claude Code), une politique de fichiers et des sauvegardes
préalables. Elle conserve les commandes avancées et l'exécution UXP complète
nécessaires à un usage professionnel d'InDesign. La licence d'origine est
conservée dans `LICENSE`.
