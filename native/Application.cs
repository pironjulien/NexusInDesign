using System.Diagnostics;
using System.Text.Json.Nodes;
using NexusInDesign.Discovery;
using NexusInDesign.InDesign;
using NexusInDesign.Security;
using NexusInDesign.Verification;
using NexusInDesign.Workflows;

namespace NexusInDesign;

/// <summary>
/// The tools: arguments checked against their contract and the path policy, every call audited and queued (one
/// InDesign command at a time), mutations checked against the revision and stateToken read before and after.
/// </summary>
internal sealed class Application
{
    public const string Instructions = "Ce serveur donne à l’agent (Codex ou Claude Code) un accès complet et contrôlé à Adobe InDesign, uniquement par le canal silencieux (COM et UXP, sans panneau, plugin ni réseau). Voie normale : silent_status, silent_list_documents, open_document (qui renvoie documentId, revision et stateToken), puis run_layout_script pour chaque changement cohérent : en un seul passage, il contrôle l’état, sauvegarde tous les documents ouverts, exécute le script UXP, enregistre si demandé et rend un aperçu PNG à regarder. Il renvoie la nouvelle revision et le nouveau stateToken : enchaînez sans réinspecter. Un échec du script renvoie scriptOk=false et backupId (silent_restore_backup), sans bloquer la suite. Regroupez le travail en peu d’appels. Si le projet possède un générateur ou des scripts versionnés, ils restent la source de vérité ; passez leur contenu à run_layout_script.\n\nFinalisez avec preflight_document puis finalize_layout ou export_pdf, et fermez avec silent_close_document. Le code libre (run_layout_script, execute_uxp_silent) a les permissions système et réseau complètes des scripts Adobe : n’exécutez que du code décidé pour la tâche. Les chemins des outils structurés restent bornés. Toutes les commandes InDesign passent par une file commune, sont sauvegardées et auditées sans journaliser le code ni le contenu. Après une issue inconnue, consultez silent_operation_status ; si elle reste orpheline, silent_reconcile_unknown_operation avant toute nouvelle mutation (redémarrez InDesign s’il le demande).";

    private static readonly HashSet<string> StructuredReads = ["get_document_info", "list_pages", "get_links", "get_fonts", "get_overset_text", "get_images"];
    private static readonly HashSet<string> StateGuardedRoutes = ["silent-direct", "workflow"];

    private readonly Config config;
    private readonly IParentVerifier parentVerifier;
    private readonly IInDesignHost host;
    private readonly SemaphoreSlim queue = new(1, 1);
    private int queued;
    private SilentBridge? bridge;
    private ToolError? bridgeError;
    private PathPolicy? pathPolicy;
    private AuditLogger audit = new(null);

    public Application(Config config, IParentVerifier parentVerifier, IInDesignHost host)
    {
        this.config = config;
        this.parentVerifier = parentVerifier;
        this.host = host;
        Catalog = ToolCatalog.Shared;
    }

    public ToolCatalog Catalog { get; }
    internal SilentBridge? Bridge => bridge;
    public int QueueLength => Volatile.Read(ref queued);

    public void Start()
    {
        parentVerifier.Verify();
        PrivateAcl.PrepareDirectory(config.PrivateRoot);
        string auditDirectory = PrivateAcl.PrepareDirectory(Path.GetDirectoryName(config.AuditFile)!);
        string auditFile = Path.Combine(auditDirectory, Path.GetFileName(config.AuditFile));
        using (new FileStream(auditFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { }
        if (new FileInfo(auditFile).Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new ToolError("CONFIG_INVALID", "Le journal interne ne peut pas être un lien.");
        PrivateAcl.Protect(auditFile, directory: false);
        audit = new AuditLogger(auditFile);
        PrivateAcl.PrepareDirectory(config.BackupRoot);
        pathPolicy = PathPolicy.Create(config.ReadRoots, config.WriteRoots, config.DeniedRoots);
        bridge = new SilentBridge(host, config.BackupRoot, config.RuntimeRoot, config.CommandTimeout, config.MaxPayloadBytes);
        CleanupBackups();
        try
        {
            bridge.Initialize();
            bridgeError = null;
        }
        catch (Exception exception)
        {
            bridgeError = ToolError.From(exception, "SILENT_CHANNEL_UNAVAILABLE");
        }
    }

    public void Stop() => bridge?.Close();

    private JsonObject CleanupBackups() => BackupRetention.Cleanup(config.BackupRoot, Path.Combine(config.RuntimeRoot, ".mutation-lease.json"), config.BackupMaxAge, config.BackupMaxFiles);

    private SilentBridge Silent() => bridgeError is null && bridge is not null
        ? bridge
        : throw new ToolError("SILENT_CHANNEL_UNAVAILABLE", $"Le canal silencieux est indisponible : {bridgeError?.Message}");

    // ----- MCP tool call ---------------------------------------------------------------------------------------------

    public async Task<JsonObject> CallTool(string name, JsonObject arguments)
    {
        var started = Stopwatch.StartNew();
        var tool = Catalog.Find(name);
        if (tool is null) return Error($"Outil inconnu : {name}");
        var args = (JsonObject)arguments.DeepClone();
        if (ToolCatalog.Validate(tool, args) is { } invalid) return Error($"Paramètres invalides : {invalid}");
        long? documentId = Json.Long(args, "documentId"), revision = Json.Long(args, "expectedRevision");
        string? reason = Json.Str(args, "reason");
        try
        {
            ApplyPathPolicy(tool, args);
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            TryAudit(new AuditLogger.Event("tool_call", name, "validation_error")
            {
                DocumentId = documentId, ExpectedRevision = revision, Reason = reason, ErrorCode = error.Code, DurationMs = started.ElapsedMilliseconds,
            });
            return Error($"{error.Code}: {error.Message}");
        }
        try
        {
            audit.Write(new AuditLogger.Event("tool_call_start", name, "started") { DocumentId = documentId, ExpectedRevision = revision, Reason = reason });
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return Error("AUDIT_UNAVAILABLE: la commande n’a pas été envoyée à InDesign car le journal de début est indisponible.");
        }

        JsonObject result;
        try
        {
            if (Interlocked.Increment(ref queued) > config.MaxQueueLength)
                throw new ToolError("QUEUE_FULL", "La file des commandes InDesign est pleine.");
            await queue.WaitAsync().ConfigureAwait(false);
            try
            {
                result = Json.AsObject(await DispatchWithLease(tool, args).ConfigureAwait(false));
                if (result.Parent is not null) result = (JsonObject)result.DeepClone();
            }
            finally { queue.Release(); }
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            TryAudit(new AuditLogger.Event("tool_call", name, "error")
            {
                DocumentId = documentId, ExpectedRevision = revision, Reason = reason, ErrorCode = error.Code, DurationMs = started.ElapsedMilliseconds,
                BackupIds = new[] { error.BackupId }.Concat(error.SafetyBackups?.OfType<JsonObject>().Select(backup => Json.Str(backup, "backupId")) ?? []),
                OperationId = error.OperationId, RequiresInspection = error.RequiresInspection,
            });
            return Error($"{error.Code}: {error.Message}", error.HasRecovery ? error.Recovery() : null);
        }
        finally
        {
            Interlocked.Decrement(ref queued);
        }

        try
        {
            var backupIds = new List<string?> { Json.Str(result, "backupId") };
            foreach (string field in new[] { "safetyBackups", "recoveryBackups" })
                backupIds.AddRange((result[field] as JsonArray ?? []).OfType<JsonObject>().Select(backup => Json.Str(backup, "backupId")));
            audit.Write(new AuditLogger.Event("tool_call", name, "success")
            {
                DocumentId = documentId, ExpectedRevision = revision, Reason = reason, DurationMs = started.ElapsedMilliseconds, BackupIds = backupIds,
                OperationId = Json.Str(result, "operationId"), RequiresInspection = Json.IsTrue(result, "requiresInspection"),
            });
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            result["auditWarning"] ??= "Le résultat InDesign est valide, mais l’événement final n’a pas pu être écrit dans le journal d’audit.";
        }
        return new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = result.ToJsonString(Json.Compact) }),
            ["structuredContent"] = result,
        };
    }

    private void TryAudit(AuditLogger.Event entry)
    {
        try { audit.Write(entry); } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }

    private static JsonObject Error(string message, JsonObject? details = null)
    {
        if (details is null)
            return new JsonObject { ["isError"] = true, ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = message }) };
        var structured = new JsonObject { ["error"] = message };
        Json.Merge(structured, details);
        return new JsonObject
        {
            ["isError"] = true,
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = structured.ToJsonString(Json.Compact) }),
            ["structuredContent"] = structured,
        };
    }

    private void ApplyPathPolicy(ToolContract tool, JsonObject args)
    {
        var policy = pathPolicy ?? throw new ToolError("SERVER_NOT_STARTED", "Le serveur n’est pas démarré.");
        foreach (var rule in tool.PathRules)
        {
            if (Json.Str(args, rule.Field) is not { } value) continue;
            string checkedPath = rule.Access == "read" ? policy.ValidateRead(value, rule.Extensions, rule.Kind) : policy.ValidateWrite(value, rule.Extensions, rule.Kind);
            args[rule.Field] = checkedPath;
            if (rule.Access == "write" && rule.MustNotExist && (File.Exists(checkedPath) || Directory.Exists(checkedPath)))
                throw new ToolError("TARGET_EXISTS", "La cible existe déjà ; l’écrasement implicite est refusé.");
        }
    }

    // ----- Dispatch --------------------------------------------------------------------------------------------------

    private async Task<JsonNode?> DispatchWithLease(ToolContract tool, JsonObject args)
    {
        bool exclusive = tool.MutatesDocument || tool.Destructive;
        bool ownsLease = tool.Route == "silent" && tool.Name != "preflight_document";
        if (!exclusive || ownsLease || tool.Name == "create_document") return await Dispatch(tool, args).ConfigureAwait(false);
        string operationId = Json.NewId();
        return await Silent().WithMutationGuard(operationId, async () => Json.AsObject(await DispatchGuarded(tool, args).ConfigureAwait(false))).ConfigureAwait(false);
    }

    private static bool RequiresExpectedState(ToolContract tool, JsonObject args) =>
        StateGuardedRoutes.Contains(tool.Route) && tool.MutatesDocument && tool.Name != "create_document" && Json.Long(args, "documentId") is not null;

    private async Task<JsonObject> InspectState(long documentId)
    {
        var inspected = await Silent().InspectDocument(documentId).ConfigureAwait(false);
        if (inspected["document"] is not JsonObject document || Json.Long(document, "documentId") != documentId || Json.Long(document, "revision") is not >= 0
            || !Json.StateToken().IsMatch(Json.Str(document, "stateToken") ?? ""))
            throw new ToolError("DOCUMENT_STATE_INVALID", "L’inspection silencieuse du document a renvoyé un état invalide.");
        return document;
    }

    private async Task<JsonNode?> DispatchGuarded(ToolContract tool, JsonObject args)
    {
        string? verified = null;
        if (RequiresExpectedState(tool, args))
        {
            var inspected = await InspectState(Json.Long(args, "documentId")!.Value).ConfigureAwait(false);
            if (Json.Long(inspected, "revision") != Json.Long(args, "expectedRevision"))
                throw new ToolError("REVISION_CONFLICT", "Le document a changé depuis la dernière lecture.");
            if (Json.Str(args, "expectedStateToken") is not { } token || !Json.StateToken().IsMatch(token))
                throw new ToolError("STATE_TOKEN_REQUIRED", "Le stateToken observé avant la mutation est obligatoire.");
            if (Json.Str(inspected, "stateToken") != token)
                throw new ToolError("STATE_CONFLICT", "Le contenu ou la structure du document a changé depuis la dernière inspection.");
            verified = token;
        }
        var result = Json.AsObject(await Dispatch(tool, args, verified).ConfigureAwait(false));
        if (!StateGuardedRoutes.Contains(tool.Route) || !tool.MutatesDocument) return result;
        var nested = result["result"] as JsonObject;
        long? targetId = Json.Long(result, "workingDocumentId") ?? Json.Long(nested, "workingDocumentId")
            ?? Json.Long(result, "documentId") ?? Json.Long(nested, "documentId") ?? Json.Long(args, "documentId");
        string? tokenField = Json.Long(result, "workingDocumentId") is not null ? "workingStateToken" : null;
        long? expectedRevision = tokenField is null ? Json.Long(result, "revision") ?? Json.Long(nested, "revision") : Json.Long(result, "workingRevision");
        if (targetId is null) return result;
        JsonObject after;
        try { after = await InspectState(targetId.Value).ConfigureAwait(false); }
        catch (Exception exception)
        {
            var error = ToolError.From(exception, "STATE_VERIFICATION_FAILED");
            error.RequiresInspection = true;
            throw error;
        }
        if (expectedRevision is not null && Json.Long(after, "revision") != expectedRevision)
            throw new ToolError("REVISION_RESULT_MISMATCH", "La révision relue après la commande ne correspond pas au résultat InDesign.", true);
        string? reported = tokenField is null ? Json.Str(result, "stateToken") ?? Json.Str(nested, "stateToken") : Json.Str(result, tokenField);
        if (tool.Route == "silent-direct" && !Json.StateToken().IsMatch(reported ?? ""))
            throw new ToolError("DOCUMENT_STATE_INVALID", "Le canal d’exécution n’a pas renvoyé le stateToken obligatoire après la commande.", true);
        if (reported is not null && reported != Json.Str(after, "stateToken"))
            throw new ToolError("STATE_VERIFICATION_FAILED", "Le stateToken renvoyé ne correspond pas à l’état relu dans InDesign.", true);
        result["stateToken"] = Json.Str(after, "stateToken");
        if (tokenField is not null) result[tokenField] = Json.Str(after, "stateToken");
        return result;
    }

    private async Task<JsonNode?> Dispatch(ToolContract tool, JsonObject args, string? verifiedToken = null)
    {
        long Id() => Json.Long(args, "documentId")!.Value;
        long Revision() => Json.Long(args, "expectedRevision")!.Value;
        string Token() => Json.Str(args, "expectedStateToken")!;
        switch (tool.Name)
        {
            case "indesign_doctor": return Doctor(Json.IsTrue(args, "includeTools"));
            case "search_official_dom": return DomIndex.Search(Json.Str(args, "query") ?? "", (int)(Json.Long(args, "limit") ?? 10));
            case "silent_status":
                if (bridgeError is not null || bridge is null)
                    return new JsonObject { ["available"] = false, ["mode"] = "silent-com-uxp", ["message"] = "Le canal silencieux est indisponible.", ["code"] = bridgeError?.Code };
                try
                {
                    var status = await bridge.Status().ConfigureAwait(false);
                    var output = new JsonObject { ["available"] = true };
                    Json.Merge(output, status);
                    if (Json.Long(status["restoredMarkerRefresh"], "removed") > 0) output["retention"] = CleanupBackups();
                    output["serverQueueLength"] = QueueLength;
                    return output;
                }
                catch (ToolError error)
                {
                    return new JsonObject
                    {
                        ["available"] = false, ["mode"] = "silent-com-uxp", ["code"] = error.Code,
                        ["message"] = error.Code == "MUTATION_IN_PROGRESS" ? error.Message : "InDesign ne répond pas par COM.",
                        ["operationId"] = error.OperationId,
                    };
                }
            case "silent_list_documents": return await Silent().ListDocuments().ConfigureAwait(false);
            case "silent_inspect_document": return await Silent().InspectDocument(Id()).ConfigureAwait(false);
            case "silent_audit_document": return await Silent().AuditDocument(Id(), Json.Long(args, "maxItems") ?? 20_000).ConfigureAwait(false);
            case "silent_close_document": return await Silent().CloseDocument(Id(), Revision(), Token(), Json.IsTrue(args, "save")).ConfigureAwait(false);
            case "silent_operation_status": return await Silent().OperationStatus(Json.Str(args, "operationId")!).ConfigureAwait(false);
            case "silent_reconcile_unknown_operation":
                return await Silent().ReconcileUnknownOperation(Json.Str(args, "operationId")!, Json.Str(args, "reason") ?? "").ConfigureAwait(false);
            case "silent_restore_backup": return await Silent().RestoreBackup(Id(), Revision(), Token(), Json.Str(args, "backupId")!).ConfigureAwait(false);
            case "open_document": return await Silent().OpenDocument(Json.Str(args, "path")!).ConfigureAwait(false);
            case "create_document":
                return await Silent().CreateDocument(
                    Json.Number(args["width"]) ?? 0, Json.Number(args["height"]) ?? 0, Json.Long(args, "pageCount") ?? 1,
                    Json.Bool(args, "facingPages") ?? true, Json.Str(args, "units") ?? "mm",
                    Numbers(args["margins"]), Numbers(args["bleed"]), Json.Str(args, "path")).ConfigureAwait(false);
            case "preflight_document":
            {
                var result = await Silent().PreflightDocument(Id(), Json.Long(args, "expectedRevision"), Json.Str(args, "profileName"),
                    Json.Long(args, "timeoutSeconds") ?? 60).ConfigureAwait(false);
                result.Remove("operationId");
                return result;
            }
            case "run_layout_script":
                return await Silent().RunLayoutScript(Id(), Revision(), Token(), Json.Str(args, "code")!, args["input"]?.DeepClone(),
                    Json.IsTrue(args, "save"), Json.IsTrue(args, "close"), Json.Str(args, "previewPages"), Json.Long(args, "previewResolution") ?? 96).ConfigureAwait(false);
            case "execute_uxp_silent":
                return await Silent().ExecuteDocument(Id(), Revision(), Token(), Json.Str(args, "code")!, args["input"]?.DeepClone()).ConfigureAwait(false);
        }
        if (StructuredReads.Contains(tool.Name)) return await Silent().ReadDocument(tool.Name, Id()).ConfigureAwait(false);
        if (tool.Route == "workflow") return await DispatchWorkflow(tool, args, verifiedToken).ConfigureAwait(false);
        if (tool.Route == "silent-direct") return await DispatchDirect(tool.Name, args, verifiedToken).ConfigureAwait(false);
        throw new ToolError("TOOL_ROUTE_UNKNOWN", $"Route inconnue pour {tool.Name}.");
    }

    private static double[] Numbers(JsonNode? node) => (node as JsonArray ?? []).Select(entry => Json.Number(entry) ?? double.NaN).ToArray();

    private static long ExpectedPageCount(string? pageRange, long pageCount)
    {
        if (pageCount < 1) throw new ToolError("DOCUMENT_STATE_INVALID", "Le nombre de pages InDesign est invalide avant export.");
        string value = (pageRange ?? "all").Trim().ToLowerInvariant();
        if (value == "all") return pageCount;
        var selected = new HashSet<long>();
        foreach (string token in value.Split(','))
        {
            var match = System.Text.RegularExpressions.Regex.Match(token.Trim(), @"^(\d+)(?:-(\d+))?$");
            if (!match.Success) throw new ToolError("PAGE_RANGE_INVALID", "La plage de pages PNG est invalide.");
            long start = long.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            long end = match.Groups[2].Success ? long.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture) : start;
            if (start < 1 || end < start || end > pageCount) throw new ToolError("PAGE_RANGE_INVALID", "La plage de pages PNG sort du document.");
            for (long page = start; page <= end; page++) selected.Add(page);
        }
        return selected.Count;
    }

    /// <summary>Exports and saves: target protection, the silent command, then the produced artifact verified.</summary>
    private async Task<JsonObject> DispatchDirect(string command, JsonObject args, string? verifiedToken)
    {
        var silent = Silent();
        long documentId = Json.Long(args, "documentId")!.Value, revision = Json.Long(args, "expectedRevision")!.Value;
        string token = verifiedToken ?? Json.Str(args, "expectedStateToken")!;
        bool singlePng = command == "export_png" && Json.Long(args, "pageId") is not null;
        (string Field, string Kind, bool CreateDirectory)? target = command switch
        {
            "save_as" => ("path", "file", false),
            "export_pdf" or "export_idml" => ("filePath", "file", false),
            "export_png" => singlePng ? ("filePath", "file", false) : ("folderPath", "directory", true),
            "package_document" => ("folderPath", "directory", true),
            _ => null,
        };
        string? artifactKind = command switch
        {
            "export_pdf" => "pdf",
            "export_idml" => "idml",
            "export_png" => singlePng ? "png" : "multipage-png",
            "package_document" => "package",
            "save_as" => "indd",
            _ => null,
        };
        long? expectedPngCount = null;
        if (command == "export_png" && !singlePng)
        {
            var info = await silent.ReadDocument("get_document_info", documentId).ConfigureAwait(false);
            expectedPngCount = ExpectedPageCount(Json.Str(args, "pageRange"), Json.Long(info["document"], "pages") ?? 0);
        }
        JsonObject protection = [];
        string? targetPath = target is null ? null : Json.Str(args, target.Value.Field);
        if (target is not null && targetPath is not null)
            protection = OutputProtection.Prepare(targetPath, target.Value.Kind, Json.IsTrue(args, "overwrite"), config.BackupRoot);
        bool createdDirectory = false;
        if (target is { CreateDirectory: true } && targetPath is not null)
        {
            if (Json.Str(protection, "targetBackupId") is not null) Directory.Delete(targetPath, recursive: true);
            if (Directory.Exists(targetPath) || File.Exists(targetPath))
                throw new ToolError("TARGET_EXISTS", "La cible a été créée entre sa vérification et l’export ; aucun écrasement non protégé n’a eu lieu.");
            Directory.CreateDirectory(targetPath);
            createdDirectory = true;
        }
        if (command == "save_as" && Json.Str(protection, "targetBackupId") is not null && targetPath is not null) File.Delete(targetPath);
        JsonArray? safetyBackups = null;
        try
        {
            var ready = await InspectState(documentId).ConfigureAwait(false);
            if (Json.Long(ready, "revision") != revision || Json.Str(ready, "stateToken") != token)
                throw new ToolError("STATE_CONFLICT", "Le document a changé juste avant l’envoi de la commande à InDesign.");
            JsonObject response = command is "save_document" or "save_as"
                ? await silent.SaveDocument(documentId, revision, token, command == "save_as" ? targetPath : null).ConfigureAwait(false)
                : await silent.ExportDocument(new SilentBridge.ExportRequest(command, documentId, revision, token)
                {
                    FilePath = command == "export_png" && !singlePng ? null : Json.Str(args, "filePath"),
                    FolderPath = Json.Str(args, "folderPath"),
                    PageId = Json.Long(args, "pageId"),
                    PageRange = Json.Str(args, "pageRange") ?? "all",
                    Resolution = Json.Long(args, "resolution") ?? 300,
                    TransparentBackground = Json.IsTrue(args, "transparentBackground"),
                    PresetName = Json.Str(args, "presetName"),
                    IncludeFonts = Json.Bool(args, "includeFonts") ?? true,
                    IncludeLinks = Json.Bool(args, "includeLinks") ?? true,
                    IncludeProfiles = Json.Bool(args, "includeProfiles") ?? true,
                    IncludeHiddenLayers = Json.IsTrue(args, "includeHiddenLayers"),
                    IgnorePreflightErrors = Json.IsTrue(args, "ignorePreflightErrors"),
                    IncludeIdml = Json.Bool(args, "includeIdml") ?? true,
                    IncludePdf = Json.Bool(args, "includePdf") ?? true,
                    PdfPresetName = Json.Str(args, "pdfPresetName"),
                }).ConfigureAwait(false);
            safetyBackups = response["safetyBackups"] as JsonArray;
            var targetBackup = safetyBackups?.OfType<JsonObject>().FirstOrDefault(backup => Json.Long(backup, "documentId") == documentId);
            var inner = response["result"] as JsonObject;
            var paths = (inner?["paths"] as JsonArray)?.Select(entry => entry?.GetValue<string>() ?? "").ToList();
            if (expectedPngCount is not null && (paths is null || paths.Count != expectedPngCount))
                throw new ToolError("ARTIFACT_PAGE_COUNT_MISMATCH", $"InDesign a déclaré {paths?.Count ?? 0} PNG sur {expectedPngCount} attendus.");
            JsonObject? verification = artifactKind is not null && targetPath is not null ? ArtifactVerifier.Verify(targetPath, artifactKind, paths) : null;
            var output = Json.AsObject(inner?.DeepClone() ?? new JsonObject());
            output["documentId"] = Json.Long(response, "documentId") ?? documentId;
            output["revision"] = response["revision"]?.DeepClone();
            output["stateToken"] = Json.Str(response, "stateToken") ?? Json.Str(inner, "stateToken");
            output["backupId"] = Json.Str(targetBackup, "backupId");
            output["backupPath"] = Json.Str(targetBackup, "backupPath");
            output["backupMetadataPath"] = Json.Str(targetBackup, "metadataPath");
            output["backupArtifactSha256"] = Json.Str(targetBackup, "artifactSha256");
            output["safetyBackups"] = safetyBackups?.DeepClone();
            output["executionChannel"] = "silent";
            output["operationId"] = Json.Str(response, "operationId");
            Json.Merge(output, protection);
            if (verification is not null) output["artifactVerification"] = verification;
            foreach (var key in output.Where(pair => pair.Value is null).Select(pair => pair.Key).ToList()) output.Remove(key);
            return output;
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            if (createdDirectory && targetPath is not null)
            {
                if (!error.RequiresInspection) { try { Directory.Delete(targetPath, recursive: true); } catch (IOException) { } }
                else error.PartialOutputPath ??= targetPath;
            }
            error.WithBackups(safetyBackups ?? error.SafetyBackups, documentId);
            error.TargetBackupId ??= Json.Str(protection, "targetBackupId");
            error.TargetBackupPath ??= Json.Str(protection, "targetBackupPath");
            throw error;
        }
    }

    private async Task<JsonObject> CaptureLayout(JsonObject args)
    {
        long documentId = Json.Long(args, "documentId")!.Value;
        var snapshot = await Silent().ReadDocument("analyze_layout", documentId, Json.Long(args, "maxItems")).ConfigureAwait(false);
        if (Json.Long(args, "expectedRevision") is long expected && Json.Long(snapshot, "revision") != expected)
            throw new ToolError("REVISION_CONFLICT", "Le document a changé depuis la dernière lecture.");
        return LayoutWorkflow.Analyze(snapshot, args["contract"] as JsonObject);
    }

    private async Task<JsonObject> DispatchWorkflow(ToolContract tool, JsonObject args, string? verifiedToken)
    {
        switch (tool.Name)
        {
            case "analyze_layout":
                return await CaptureLayout(args).ConfigureAwait(false);
            case "compare_layout_snapshot":
            {
                var analysis = await CaptureLayout(args).ConfigureAwait(false);
                string baseline = Json.Str(args, "baselineFingerprint") ?? "";
                return new JsonObject
                {
                    ["matches"] = Json.Str(analysis, "fingerprint") == baseline, ["baselineFingerprint"] = baseline,
                    ["currentFingerprint"] = Json.Str(analysis, "fingerprint"), ["statistics"] = analysis["statistics"]?.DeepClone(),
                    ["anomalies"] = LayoutWorkflow.SummarizeAnomalies(analysis["lint"] as JsonObject),
                };
            }
            case "create_working_copy":
            {
                string path = Json.Str(args, "path")!;
                return await Silent().CreateWorkingCopy(Json.Long(args, "documentId")!.Value, Json.Long(args, "expectedRevision")!.Value,
                    verifiedToken ?? Json.Str(args, "expectedStateToken")!, path,
                    () => OutputProtection.Prepare(path, "file", Json.IsTrue(args, "overwrite"), config.BackupRoot)).ConfigureAwait(false);
            }
            case "preview_layout":
            {
                var before = await CaptureLayout(args).ConfigureAwait(false);
                var exportArgs = Pick(args, "documentId", "expectedRevision", "expectedStateToken", "reason", "folderPath", "pageRange", "resolution", "transparentBackground", "overwrite");
                var preview = await DispatchDirect("export_png", exportArgs, verifiedToken).ConfigureAwait(false);
                var afterArgs = (JsonObject)args.DeepClone();
                afterArgs["expectedRevision"] = preview["revision"]?.DeepClone() ?? args["expectedRevision"]?.DeepClone();
                var after = await CaptureLayout(afterArgs).ConfigureAwait(false);
                if (Json.Str(before, "fingerprint") != Json.Str(after, "fingerprint"))
                    throw new ToolError("PREVIEW_ROUND_TRIP_MISMATCH", "La mise en page a changé pendant la production de l’aperçu.", true) { PartialOutputPath = Json.Str(args, "folderPath") };
                return new JsonObject { ["preview"] = preview, ["analysis"] = after, ["sourceUnchanged"] = true };
            }
            case "finalize_layout":
            {
                var analysis = await CaptureLayout(args).ConfigureAwait(false);
                if (!Json.IsTrue(analysis["lint"], "passed"))
                    return new JsonObject
                    {
                        ["exported"] = false, ["gate"] = "layout-contract",
                        ["message"] = "Le PDF final n’a pas été produit car le contrat contient des écarts bloquants.", ["analysis"] = analysis,
                    };
                var preflight = await Silent().PreflightDocument(Json.Long(args, "documentId")!.Value, Json.Long(args, "expectedRevision"),
                    Json.Str(args, "profileName"), Json.Long(args, "timeoutSeconds") ?? 60).ConfigureAwait(false);
                if (preflight["aggregatedResults"] is not JsonArray aggregated || aggregated.Count < 3 || aggregated[2] is not JsonArray findings)
                    throw new ToolError("PREFLIGHT_RESULT_INVALID", "Le contrôle Adobe n’a pas renvoyé sa structure de résultats officielle.");
                if (findings.Count > 0)
                    return new JsonObject
                    {
                        ["exported"] = false, ["gate"] = "adobe-preflight",
                        ["message"] = "Le PDF final n’a pas été produit car le contrôle Adobe contient des erreurs.",
                        ["analysis"] = analysis, ["preflight"] = preflight, ["preflightIssues"] = findings.Count,
                    };
                var pdf = await DispatchDirect("export_pdf", Pick(args, "documentId", "expectedRevision", "expectedStateToken", "reason", "filePath", "presetName", "overwrite"), verifiedToken).ConfigureAwait(false);
                return new JsonObject { ["exported"] = true, ["gate"] = "passed", ["analysis"] = analysis, ["preflight"] = preflight, ["pdf"] = pdf };
            }
            default:
                throw new ToolError("WORKFLOW_UNKNOWN", $"Workflow inconnu : {tool.Name}");
        }
    }

    private static JsonObject Pick(JsonObject source, params string[] names)
    {
        var output = new JsonObject();
        foreach (string name in names)
            if (source.TryGetPropertyValue(name, out var value)) output[name] = value?.DeepClone();
        return output;
    }

    // ----- Doctor ----------------------------------------------------------------------------------------------------

    private JsonObject Doctor(bool includeTools)
    {
        static JsonObject Check(string id, string status, JsonObject? details = null) =>
            Json.Merge(new JsonObject { ["id"] = id, ["status"] = status }, details);
        var tools = Catalog.PublicList();
        string registryHash = Json.Sha256(Json.Canonical(tools));
        JsonObject officialDom;
        try { officialDom = Json.Merge(new JsonObject { ["available"] = true }, DomIndex.Info()); }
        catch (ToolError error) { officialDom = new JsonObject { ["available"] = false, ["code"] = error.Code }; }
        bool storage = Directory.Exists(config.BackupRoot) && File.Exists(audit.FilePath ?? "")
            && PathPolicy.IsInside(config.PrivateRoot, config.BackupRoot) && PathPolicy.IsInside(config.PrivateRoot, audit.FilePath ?? config.PrivateRoot);
        bool silentAvailable = bridge is not null && bridgeError is null;
        var registry = new JsonObject { ["toolProfile"] = "core", ["toolCount"] = tools.Count, ["registryHash"] = registryHash };
        if (includeTools) registry["tools"] = Json.Array(tools.OfType<JsonObject>().Select(tool => (JsonNode?)tool["name"]?.DeepClone()));
        var checks = new JsonArray
        {
            Check("engine", "pass", new JsonObject { ["version"] = Program.Version, ["runtime"] = Environment.Version.ToString() }),
            Check("no-network-listener", "pass"),
            Check("parent-policy", config.AllowedParents.Count > 0 && config.AllowedParentPaths.Count > 0 ? "pass" : "fail", new JsonObject
            {
                ["allowedAgentCount"] = config.AllowedParents.Count, ["allowedPathCount"] = config.AllowedParentPaths.Count,
            }),
            Check("private-storage", storage ? "pass" : "fail", new JsonObject { ["persistentAudit"] = audit.FilePath is not null }),
            Check("tool-registry", tools.Count == Catalog.Tools.Count ? "pass" : "fail", new JsonObject { ["toolCount"] = tools.Count, ["registryHash"] = registryHash }),
            Check("official-dom-index", Json.IsTrue(officialDom, "available") ? "pass" : "fail", Json.IsTrue(officialDom, "available")
                ? new JsonObject { ["entryCount"] = officialDom["entryCount"]?.DeepClone(), ["sourceRevision"] = officialDom["source"]?["commit"]?.DeepClone() }
                : new JsonObject { ["code"] = officialDom["code"]?.DeepClone() }),
            Check("silent-channel", silentAvailable ? "pass" : "unavailable", new JsonObject { ["hostChecked"] = false }),
        };
        bool failure = checks.OfType<JsonObject>().Any(entry => Json.Str(entry, "status") == "fail");
        var nextActions = new JsonArray();
        nextActions.Add(silentAvailable
            ? "Utiliser silent_status pour vérifier le processus InDesign réel ; le doctor local ne démarre jamais InDesign."
            : "Réparer le canal silencieux (stockage privé, runtime) avant toute exécution.");
        return new JsonObject
        {
            ["status"] = failure ? "error" : silentAvailable ? "ready-unverified" : "degraded",
            ["checkedAt"] = DateTime.UtcNow.ToString("o"),
            ["hostProbePerformed"] = false,
            ["checks"] = checks,
            ["channels"] = new JsonObject { ["silent"] = new JsonObject { ["engineAvailable"] = silentAvailable, ["hostChecked"] = false, ["hostAvailable"] = null } },
            ["capabilities"] = new JsonObject
            {
                ["localDiagnostics"] = true, ["officialDomReference"] = Json.IsTrue(officialDom, "available"),
                ["silentInspectionEngine"] = silentAvailable, ["silentFullUxpEngine"] = silentAvailable,
            },
            ["registry"] = registry,
            ["officialDom"] = officialDom,
            ["nextActions"] = nextActions,
        };
    }
}
