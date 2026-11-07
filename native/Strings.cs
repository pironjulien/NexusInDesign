using System.Globalization;

namespace NexusInDesign;

/// <summary>
/// Every text the engine shows (MCP instructions, tool descriptions, results, errors): English by default, French when
/// the Windows display language is French. Read on each call from <see cref="CultureInfo.CurrentUICulture"/>, so a test
/// can switch language for its own async flow. The UXP scripts follow the same choice through @@FRENCH@@.
/// </summary>
internal static class Strings
{
    internal static bool French => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "fr";

    internal static string T(string english, string french) => French ? french : english;

    internal static string Instructions => T(
        "This server gives the agent (Codex or Claude Code) full, controlled access to Adobe InDesign, only through the silent channel (COM and UXP, no panel, plugin or network). Normal path: silent_status, silent_list_documents, open_document (which returns documentId, revision and stateToken), then run_layout_script for each coherent change: in a single pass it checks the state, backs up every open document, runs the UXP script, saves when asked and renders a PNG preview to look at. It returns the new revision and the new stateToken: chain calls without inspecting again. A failed script returns scriptOk=false and backupId (silent_restore_backup) without blocking what follows. Group the work into few calls. If the project has a generator or versioned scripts, they stay the source of truth; pass their content to run_layout_script.\n\nFinish with preflight_document then finalize_layout or export_pdf, and close with silent_close_document. Free code (run_layout_script, execute_uxp_silent) has the full system and network permissions of Adobe scripts: run only code decided for the task. The paths of the structured tools stay bounded. Every InDesign command goes through a shared queue, is backed up and audited without logging the code or the content. After an unknown outcome, check silent_operation_status; if it stays orphaned, silent_reconcile_unknown_operation before any new mutation (restart InDesign if it asks).",
        "Ce serveur donne à l’agent (Codex ou Claude Code) un accès complet et contrôlé à Adobe InDesign, uniquement par le canal silencieux (COM et UXP, sans panneau, plugin ni réseau). Voie normale : silent_status, silent_list_documents, open_document (qui renvoie documentId, revision et stateToken), puis run_layout_script pour chaque changement cohérent : en un seul passage, il contrôle l’état, sauvegarde tous les documents ouverts, exécute le script UXP, enregistre si demandé et rend un aperçu PNG à regarder. Il renvoie la nouvelle revision et le nouveau stateToken : enchaînez sans réinspecter. Un échec du script renvoie scriptOk=false et backupId (silent_restore_backup), sans bloquer la suite. Regroupez le travail en peu d’appels. Si le projet possède un générateur ou des scripts versionnés, ils restent la source de vérité ; passez leur contenu à run_layout_script.\n\nFinalisez avec preflight_document puis finalize_layout ou export_pdf, et fermez avec silent_close_document. Le code libre (run_layout_script, execute_uxp_silent) a les permissions système et réseau complètes des scripts Adobe : n’exécutez que du code décidé pour la tâche. Les chemins des outils structurés restent bornés. Toutes les commandes InDesign passent par une file commune, sont sauvegardées et auditées sans journaliser le code ni le contenu. Après une issue inconnue, consultez silent_operation_status ; si elle reste orpheline, silent_reconcile_unknown_operation avant toute nouvelle mutation (redémarrez InDesign s’il le demande).");
}
