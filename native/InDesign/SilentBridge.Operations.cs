using System.Text.Json.Nodes;
using NexusInDesign.Verification;

namespace NexusInDesign.InDesign;

internal sealed partial class SilentBridge
{
    /// <summary>Template inputs: the JavaScript literal InDesign receives and the same value as JSON (audit, tests).</summary>
    private sealed class Inputs
    {
        public Dictionary<string, string> Raw { get; } = new(StringComparer.Ordinal);
        public JsonObject Values { get; } = [];

        public Inputs Add(string name, object? value)
        {
            Raw[name] = Json.Literal(value);
            Values[name] = value switch
            {
                null => null,
                JsonNode node => node.DeepClone(),
                string text => text,
                bool flag => flag,
                long number => number,
                int number => number,
                double number => number,
                _ => JsonValue.Create(value.ToString()),
            };
            return this;
        }

        public Inputs Fragment(string name, string javascript)
        {
            Raw[name] = javascript;
            return this;
        }

        public string Render(string template) => UxpTemplates.Render(template, Raw);
    }

    private static readonly HashSet<string> AuditSections = ["all", "document", "pages", "items", "links", "fonts", "images", "overset", "designSystem", "typography"];

    // ----- Reads -----------------------------------------------------------------------------------------------------

    public async Task<JsonObject> Status(bool refreshMarkers = true)
    {
        var inputs = new Inputs();
        var status = await RunUxpSync("status.js", inputs.Render("status.js"), inputs.Values).ConfigureAwait(false);
        if (!refreshMarkers) return status;
        status["restoredMarkerRefresh"] = Json.IsTrue(status, "modalState")
            ? new JsonObject { ["inspected"] = 0, ["removed"] = 0, ["keptOpen"] = 0, ["skippedUnreadable"] = 0, ["deferredForModalState"] = true }
            : await RefreshRestoredMarkers().ConfigureAwait(false);
        return status;
    }

    /// <summary>A restored working copy keeps its marker while InDesign has it open; closed copies lose it (retention).</summary>
    public async Task<JsonObject> RefreshRestoredMarkers()
    {
        static JsonObject Counts(int inspected, int removed, int keptOpen, int skipped) => new()
        {
            ["inspected"] = inspected, ["removed"] = removed, ["keptOpen"] = keptOpen, ["skippedUnreadable"] = skipped,
        };
        string restored = Path.Combine(BackupDirectory, "restored");
        if (!Directory.Exists(restored)) return Counts(0, 0, 0, 0);
        if (!IsRegularDirectory(restored)) return Counts(0, 0, 0, 1);
        var markers = new DirectoryInfo(restored).EnumerateFiles("restore-*.open.json")
            .Where(file => Json.Uuid().IsMatch(file.Name["restore-".Length..^".open.json".Length].ToLowerInvariant())).ToList();
        if (markers.Count == 0) return Counts(0, 0, 0, 0);
        if (File.Exists(LeasePath))
        {
            var deferred = Counts(markers.Count, 0, 0, 0);
            deferred["deferredForActiveMutation"] = true;
            return deferred;
        }
        var inputs = new Inputs();
        var state = await RunUxpRead("restored-paths.js", inputs.Render("restored-paths.js"), inputs.Values).ConfigureAwait(false);
        if (!Json.IsTrue(state, "pathsReadable") || state["openPaths"] is not JsonArray openPaths
            || openPaths.Any(entry => entry is not JsonValue value || !value.TryGetValue(out string? text) || text.Length == 0))
            return Counts(markers.Count, 0, 0, markers.Count);
        var normalized = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in openPaths)
        {
            string? path = NormalizeHostPath(entry!.GetValue<string>());
            if (path is null || !normalized.Add(path)) return Counts(markers.Count, 0, 0, markers.Count);
        }
        int removed = 0, keptOpen = 0, skipped = 0;
        foreach (var marker in markers)
        {
            string id = marker.Name["restore-".Length..^".open.json".Length];
            var content = ReadSmallJson(marker.FullName, 4096);
            string expected = $"restore-{id}.indd";
            if (content is null || marker.Attributes.HasFlag(FileAttributes.ReparsePoint) || Json.Long(content, "schemaVersion") != 1
                || !string.Equals(Json.Str(content, "workingFile"), expected, StringComparison.OrdinalIgnoreCase))
            {
                skipped++;
                continue;
            }
            if (normalized.Contains(Path.GetFullPath(Path.Combine(restored, expected)))) { keptOpen++; continue; }
            File.Delete(marker.FullName);
            removed++;
        }
        return Counts(markers.Count, removed, keptOpen, skipped);
    }

    private static string? NormalizeHostPath(string value)
    {
        try
        {
            string native = value.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ? new Uri(value).LocalPath : value;
            return Path.GetFullPath(native.Replace('/', '\\'));
        }
        catch (Exception exception) when (exception is UriFormatException or ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    public async Task<JsonObject> ListDocuments()
    {
        var inputs = new Inputs();
        return await RunUxpSync("list-documents.js", inputs.Render("list-documents.js"), inputs.Values).ConfigureAwait(false);
    }

    public async Task<JsonObject> InspectDocument(long documentId)
    {
        var inputs = new Inputs().Add("documentId", documentId);
        return await RunUxpSync("inspect-document.js", inputs.Render("inspect-document.js"), inputs.Values).ConfigureAwait(false);
    }

    public async Task<JsonObject> AuditDocument(long documentId, long maxItems = 20_000, IReadOnlyCollection<string>? sections = null)
    {
        if (documentId < 1) throw Fail("DOCUMENT_ID_INVALID", Strings.T("Invalid document id for the silent audit.", "Identifiant de document invalide pour l’audit silencieux."));
        if (maxItems is < 1 or > 50_000) throw Fail("AUDIT_LIMIT_INVALID", Strings.T("The silent audit limit must be between 1 and 50,000 items.", "La limite de l’audit silencieux doit être comprise entre 1 et 50 000 objets."));
        sections ??= ["all"];
        if (sections.Count == 0 || sections.Any(entry => !AuditSections.Contains(entry)))
            throw Fail("AUDIT_SECTIONS_INVALID", Strings.T("The sections requested for the silent audit are invalid.", "Les sections demandées pour l’audit silencieux sont invalides."));
        bool all = sections.Contains("all");
        bool Has(string name) => all || sections.Contains(name);
        long budget = Math.Max(1_024, MaxResultBytes - Math.Min(16_384, MaxResultBytes / 4));
        var inputs = new Inputs()
            .Add("documentId", documentId)
            .Add("maxItems", maxItems)
            .Add("resultBudget", budget)
            .Add("includePages", Has("pages") || Has("items"))
            .Add("includeItems", Has("items"))
            .Add("includeLinks", Has("links"))
            .Add("includeFonts", Has("fonts"))
            .Add("includeImages", Has("images"))
            .Add("includeOverset", Has("overset"))
            .Add("includeDesignSystem", Has("designSystem"))
            .Add("includeTypography", Has("typography"));
        var result = await RunUxpRead("audit-document.js", inputs.Render("audit-document.js"), inputs.Values).ConfigureAwait(false);
        if (result["audit"] is not JsonObject audit || Json.Long(audit, "documentId") != documentId || !Json.StateToken().IsMatch(Json.Str(audit, "stateToken") ?? ""))
            throw Fail("AUDIT_RESULT_INVALID", Strings.T("The silent audit result is invalid.", "Le résultat de l’audit silencieux est invalide."));
        return audit;
    }

    public async Task<JsonObject> ReadDocument(string command, long documentId, long? maxItems = null)
    {
        string[] sections = command switch
        {
            "get_document_info" => ["document"],
            "list_pages" => ["pages"],
            "get_links" => ["links"],
            "get_fonts" => ["fonts"],
            "get_overset_text" => ["overset"],
            "get_images" => ["images"],
            "analyze_layout" => ["pages", "items", "links", "fonts", "images", "designSystem", "typography"],
            _ => throw Fail("SILENT_READ_UNKNOWN", Strings.T("Unknown silent read.", "Lecture silencieuse inconnue.")),
        };
        var audit = await AuditDocument(documentId, maxItems ?? 20_000, sections).ConfigureAwait(false);
        JsonObject Common() => new() { ["success"] = true, ["documentId"] = audit["documentId"]?.DeepClone(), ["revision"] = audit["revision"]?.DeepClone() };
        JsonArray Map(string name, Func<JsonObject, JsonObject> mapper) =>
            Json.Array((audit[name] as JsonArray ?? []).OfType<JsonObject>().Select(entry => (JsonNode)mapper(entry)));
        JsonObject Pick(JsonObject source, params string[] names)
        {
            var output = new JsonObject();
            foreach (string name in names) output[name] = source[name]?.DeepClone();
            return output;
        }
        var document = audit["document"] as JsonObject ?? [];
        var counts = audit["counts"] as JsonObject ?? [];
        switch (command)
        {
            case "get_document_info":
            {
                var output = Common();
                output["document"] = new JsonObject
                {
                    ["id"] = document["id"]?.DeepClone(), ["name"] = document["name"]?.DeepClone(), ["path"] = document["path"]?.DeepClone(),
                    ["pages"] = counts["pages"]?.DeepClone(), ["spreads"] = counts["spreads"]?.DeepClone(), ["layers"] = counts["layers"]?.DeepClone(),
                    ["masterSpreads"] = counts["masterSpreads"]?.DeepClone(), ["widthMm"] = document["widthMm"]?.DeepClone(),
                    ["heightMm"] = document["heightMm"]?.DeepClone(), ["facingPages"] = document["facingPages"]?.DeepClone(),
                    ["modified"] = document["modified"]?.DeepClone(),
                };
                return output;
            }
            case "list_pages":
            {
                var output = Common();
                output["pages"] = Map("pages", page =>
                {
                    var entry = Pick(page, "id");
                    entry["pageId"] = page["id"]?.DeepClone();
                    return Json.Merge(entry, Pick(page, "index", "name", "bounds", "appliedMaster"));
                });
                return output;
            }
            case "get_links":
            {
                var output = Common();
                output["links"] = Map("links", link => Pick(link, "id", "name", "path", "status", "pageItemId"));
                return output;
            }
            case "get_fonts":
            {
                var output = Common();
                output["fonts"] = Map("fonts", font => Pick(font, "name", "family", "style", "status"));
                return output;
            }
            case "get_overset_text":
                return Json.Merge(Common(), audit["oversetText"] as JsonObject);
            case "get_images":
            {
                var output = Common();
                output["images"] = audit["images"]?.DeepClone() ?? new JsonArray();
                return output;
            }
            default:
                return LayoutSnapshotFromAudit(audit);
        }
    }

    private static JsonObject LayoutSnapshotFromAudit(JsonObject audit)
    {
        var images = Json.Array((audit["images"] as JsonArray ?? []).OfType<JsonObject>().Select(image =>
        {
            var copy = (JsonObject)image.DeepClone();
            if (image["link"] is JsonObject link) copy["link"] = new JsonObject { ["id"] = link["id"]?.DeepClone(), ["name"] = link["name"]?.DeepClone() };
            return (JsonNode)copy;
        }));
        return new JsonObject
        {
            ["success"] = true,
            ["documentId"] = audit["documentId"]?.DeepClone(),
            ["revision"] = audit["revision"]?.DeepClone(),
            ["capturedAt"] = audit["capturedAt"]?.DeepClone(),
            ["document"] = audit["document"]?.DeepClone(),
            ["pages"] = audit["pages"]?.DeepClone() ?? new JsonArray(),
            ["items"] = audit["items"]?.DeepClone() ?? new JsonArray(),
            ["links"] = audit["links"]?.DeepClone() ?? new JsonArray(),
            ["fonts"] = audit["fonts"]?.DeepClone() ?? new JsonArray(),
            ["images"] = images,
            ["designSystem"] = audit["designSystem"]?.DeepClone() ?? new JsonObject
            {
                ["layers"] = new JsonArray(), ["swatches"] = new JsonArray(), ["paragraphStyles"] = new JsonArray(),
                ["characterStyles"] = new JsonArray(), ["objectStyles"] = new JsonArray(),
            },
            ["typography"] = audit["typography"]?.DeepClone(),
            ["totalItems"] = audit["totalItems"]?.DeepClone() ?? 0,
            ["truncated"] = Json.IsTrue(audit, "truncated"),
        };
    }

    public async Task<JsonObject> PreflightDocument(long documentId, long? expectedRevision, string? profileName, long timeoutSeconds = 60)
    {
        if (documentId < 1) throw Fail("DOCUMENT_ID_INVALID", Strings.T("Invalid document id for the Adobe preflight.", "Identifiant de document invalide pour le contrôle Adobe."));
        if (expectedRevision is < 0) throw Fail("REVISION_INVALID", Strings.T("The expected revision of the Adobe preflight is invalid.", "La révision attendue du contrôle Adobe est invalide."));
        if (timeoutSeconds is < 1 or > 600) throw Fail("PREFLIGHT_TIMEOUT_INVALID", Strings.T("The Adobe preflight timeout must be between 1 and 600 seconds.", "Le délai du contrôle Adobe doit être compris entre 1 et 600 secondes."));
        if (profileName is { Length: < 1 or > 256 }) throw Fail("PREFLIGHT_PROFILE_INVALID", Strings.T("The Adobe preflight profile name is invalid.", "Le nom du profil de contrôle Adobe est invalide."));
        var inputs = new Inputs()
            .Add("documentId", documentId)
            .Add("profileName", profileName)
            .Add("timeoutSeconds", timeoutSeconds)
            .Add("expectedRevision", expectedRevision);
        var timeout = TimeSpan.FromMilliseconds(Math.Max(Timeout.TotalMilliseconds, (timeoutSeconds * 1000) + 5_000));
        return await RunUxpSync("preflight.js", inputs.Render("preflight.js"), inputs.Values, timeout).ConfigureAwait(false);
    }

    // ----- Document states and backups -------------------------------------------------------------------------------

    internal async Task<JsonArray> SnapshotAllDocuments()
    {
        var inventory = await ListDocuments().ConfigureAwait(false);
        var snapshots = new JsonArray();
        foreach (var document in (inventory["documents"] as JsonArray ?? []).OfType<JsonObject>().OrderBy(entry => Json.Long(entry, "documentId")))
        {
            long id = Json.Long(document, "documentId") ?? 0;
            var inspected = (await InspectDocument(id).ConfigureAwait(false))["document"] as JsonObject;
            if (inspected is null || Json.Long(inspected, "documentId") != id || Json.Long(inspected, "revision") != Json.Long(document, "revision")
                || !Json.StateToken().IsMatch(Json.Str(inspected, "stateToken") ?? ""))
                throw Fail("DOCUMENT_SNAPSHOT_INVALID", Strings.T("The stable inspection of the document failed.", "L’inspection stable du document a échoué."), true);
            snapshots.Add(new JsonObject { ["documentId"] = id, ["revision"] = Json.Long(inspected, "revision"), ["stateToken"] = Json.Str(inspected, "stateToken") });
        }
        return snapshots;
    }

    private static string SnapshotKey(JsonArray snapshots, bool withToken = true) => string.Join(";",
        snapshots.OfType<JsonObject>().OrderBy(entry => Json.Long(entry, "documentId"))
            .Select(entry => $"{Json.Long(entry, "documentId")}|{Json.Long(entry, "revision")}" + (withToken ? $"|{Json.Str(entry, "stateToken")}" : "")));

    internal static void AssertStableSnapshots(JsonArray expected, JsonArray actual, string message)
    {
        if (SnapshotKey(expected) != SnapshotKey(actual)) throw Fail("BACKUP_SOURCE_UNSTABLE", message, true);
    }

    private static void AssertInventoryMatches(JsonArray expectedDocuments, JsonArray snapshots)
    {
        if (SnapshotKey(expectedDocuments, withToken: false) != SnapshotKey(snapshots, withToken: false))
            throw Fail("BACKUP_SOURCE_UNSTABLE", Strings.T("The InDesign inventory changed before the backups.", "L’inventaire InDesign a changé avant les sauvegardes."), true);
    }

    private static JsonArray ExpectedDocuments(JsonArray safetyBackups) => Json.Array(safetyBackups.OfType<JsonObject>().Select(backup => (JsonNode)new JsonObject
    {
        ["documentId"] = backup["documentId"]?.DeepClone(), ["revision"] = backup["revision"]?.DeepClone(), ["stateToken"] = backup["stateToken"]?.DeepClone(),
    }));

    private string BackupPathFor(string backupId) => Path.Combine(BackupDirectory, $"backup-{backupId}.indd");

    /// <summary>Every open document copied (saveACopy) and checked unchanged, before any mutation.</summary>
    internal async Task<JsonArray> BackupDocuments(JsonArray documents)
    {
        var safetyBackups = new JsonArray();
        try
        {
            var source = await SnapshotAllDocuments().ConfigureAwait(false);
            AssertInventoryMatches(documents, source);
            foreach (var document in source.OfType<JsonObject>())
            {
                string backupId = Json.NewId();
                string backupPath = BackupPathFor(backupId);
                long id = Json.Long(document, "documentId")!.Value, revision = Json.Long(document, "revision")!.Value;
                string token = Json.Str(document, "stateToken")!;
                await CreateBackup(id, revision, backupPath, backupId).ConfigureAwait(false);
                var verified = (await InspectDocument(id).ConfigureAwait(false))["document"] as JsonObject;
                AssertStableSnapshots([document.DeepClone()], [new JsonObject
                {
                    ["documentId"] = Json.Long(verified, "documentId"), ["revision"] = Json.Long(verified, "revision"), ["stateToken"] = Json.Str(verified, "stateToken"),
                }], Strings.T("The document changed during its backup.", "Le document a changé pendant sa sauvegarde."));
                var metadata = WriteBackupMetadata(backupId, backupPath, id, revision, token);
                safetyBackups.Add(new JsonObject
                {
                    ["documentId"] = id, ["revision"] = revision, ["stateToken"] = token, ["backupId"] = backupId, ["backupPath"] = backupPath,
                    ["metadataPath"] = metadata["metadataPath"]?.DeepClone(), ["artifactSha256"] = metadata["artifact"]?["sha256"]?.DeepClone(),
                });
            }
            var final = await SnapshotAllDocuments().ConfigureAwait(false);
            AssertStableSnapshots(source, final, Strings.T("The documents changed during the backup series.", "Les documents ont changé pendant la série de sauvegardes."));
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            error.SafetyBackups ??= safetyBackups;
            throw error;
        }
        return safetyBackups;
    }

    private async Task CreateBackup(long documentId, long expectedRevision, string backupPath, string backupId)
    {
        var inputs = new Inputs()
            .Add("documentId", documentId)
            .Add("expectedRevision", expectedRevision)
            .Add("backupPath", UxpTemplates.UxpPath(backupPath))
            .Add("backupId", backupId);
        string source = inputs.Render("create-backup.jsx");
        string? result = await RunScript("create-backup.jsx", ScriptLanguage.ExtendScript, source, inputs.Values).ConfigureAwait(false);
        var fields = (result ?? "").Split('|');
        if (fields[0] == "ERR")
            throw Fail(fields.Length > 1 && fields[1].Length > 0 ? fields[1] : "BACKUP_FAILED", fields.Length > 2 ? string.Join('|', fields[2..]) : Strings.T("The InDesign backup failed.", "La sauvegarde InDesign a échoué."));
        if (fields[0] != "OK" || fields.Length != 4) throw Fail("BACKUP_RESPONSE_INVALID", Strings.T("Invalid InDesign backup answer.", "Réponse de sauvegarde InDesign invalide."));
        if (fields[1] != backupId || fields[2] != documentId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            || fields[3] != expectedRevision.ToString(System.Globalization.CultureInfo.InvariantCulture))
            throw Fail("BACKUP_RESPONSE_MISMATCH", Strings.T("The InDesign backup does not match the locally signed request.", "La sauvegarde InDesign ne correspond pas à la requête signée localement."));
        ValidateBackupArtifact(backupPath);
    }

    private static FileInfo ValidateBackupArtifact(string backupPath)
    {
        var info = new FileInfo(backupPath);
        if (!info.Exists) throw Fail("BACKUP_ARTIFACT_MISSING", Strings.T("The INDD safety copy is missing.", "La copie INDD de sécurité est introuvable."));
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length == 0)
            throw Fail("BACKUP_ARTIFACT_INVALID", Strings.T("The INDD safety copy is empty or invalid.", "La copie INDD de sécurité est vide ou invalide."));
        Protect(backupPath);
        try { ArtifactVerifier.Verify(backupPath, "indd"); }
        catch (ToolError cause)
        {
            throw new ToolError("BACKUP_ARTIFACT_INVALID", Strings.T("The INDD safety copy has no credible InDesign binary structure.", "La copie INDD de sécurité ne possède pas une structure binaire InDesign crédible."), false, cause);
        }
        info.Refresh();
        return info;
    }

    private JsonObject WriteBackupMetadata(string backupId, string backupPath, long documentId, long revision, string stateToken)
    {
        if (!Json.BackupId().IsMatch(backupId) || revision < 0 || !Json.StateToken().IsMatch(stateToken))
            throw Fail("BACKUP_PROVENANCE_INVALID", Strings.T("The provenance of the silent backup is invalid.", "La provenance de la sauvegarde silencieuse est invalide."));
        var before = ValidateBackupArtifact(backupPath);
        string sha256 = Json.Sha256File(backupPath);
        var after = new FileInfo(backupPath);
        if (!after.Exists || after.Length != before.Length || after.LastWriteTimeUtc != before.LastWriteTimeUtc)
            throw Fail("BACKUP_ARTIFACT_UNSTABLE", Strings.T("The backup changed while its hash was computed.", "La sauvegarde a changé pendant le calcul de son empreinte."));
        string metadataPath = Path.Combine(BackupDirectory, $"backup-{backupId}.meta.json");
        var metadata = new JsonObject
        {
            ["schemaVersion"] = BackupMetadataVersion, ["backupId"] = backupId, ["documentId"] = documentId, ["revision"] = revision,
            ["stateToken"] = stateToken, ["createdAt"] = DateTime.UtcNow.ToString("o"),
            ["artifact"] = new JsonObject { ["fileName"] = Path.GetFileName(backupPath), ["size"] = after.Length, ["sha256"] = sha256 },
        };
        try { WritePrivateNewFile(metadataPath, metadata.ToJsonString(Json.Compact)); }
        catch
        {
            DeleteQuietly(metadataPath);
            throw;
        }
        metadata["metadataPath"] = metadataPath;
        return metadata;
    }

    private JsonObject ReadBackupMetadata(string backupId, string backupPath, long documentId)
    {
        string metadataPath = Path.Combine(BackupDirectory, $"backup-{backupId}.meta.json");
        var info = new FileInfo(metadataPath);
        if (!info.Exists) throw Fail("BACKUP_METADATA_MISSING", Strings.T("The private provenance of the backup is missing.", "La provenance privée de la sauvegarde est introuvable."));
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length == 0 || info.Length > 16_384)
            throw Fail("BACKUP_METADATA_INVALID", Strings.T("The private provenance of the backup is invalid.", "La provenance privée de la sauvegarde est invalide."));
        Protect(metadataPath);
        var metadata = ReadSmallJson(metadataPath, 16_384) ?? throw Fail("BACKUP_METADATA_INVALID", Strings.T("The private provenance of the backup is unreadable.", "La provenance privée de la sauvegarde est illisible."));
        var artifact = metadata["artifact"] as JsonObject;
        bool valid = Json.Long(metadata, "schemaVersion") == BackupMetadataVersion && Json.Str(metadata, "backupId") == backupId
            && Json.Long(metadata, "documentId") == documentId && Json.Long(metadata, "revision") is >= 0
            && Json.StateToken().IsMatch(Json.Str(metadata, "stateToken") ?? "")
            && Json.Str(artifact, "fileName") == Path.GetFileName(backupPath)
            && Json.Long(artifact, "size") is > 0 && Json.Sha256Hex().IsMatch(Json.Str(artifact, "sha256") ?? "");
        if (!valid) throw Fail("BACKUP_PROVENANCE_MISMATCH", Strings.T("The backup does not match the requested document or its provenance is invalid.", "La sauvegarde ne correspond pas au document demandé ou sa provenance est invalide."));
        var stat = ValidateBackupArtifact(backupPath);
        if (stat.Length != Json.Long(artifact, "size") || Json.Sha256File(backupPath) != Json.Str(artifact, "sha256"))
            throw Fail("BACKUP_INTEGRITY_FAILED", Strings.T("The backup no longer matches its private provenance.", "La sauvegarde ne correspond plus à sa provenance privée."));
        metadata["metadataPath"] = metadataPath;
        return metadata;
    }

    /// <summary>Checks revision then stateToken of the target document, from a fresh inventory.</summary>
    private async Task<JsonArray> ExpectState(long documentId, long expectedRevision, string expectedStateToken, string missingMessage)
    {
        var inventory = await ListDocuments().ConfigureAwait(false);
        var documents = inventory["documents"] as JsonArray ?? [];
        var target = documents.OfType<JsonObject>().FirstOrDefault(document => Json.Long(document, "documentId") == documentId)
            ?? throw Fail("DOCUMENT_NOT_FOUND", missingMessage);
        if (Json.Long(target, "revision") != expectedRevision) throw Fail("REVISION_CONFLICT", Strings.T("The document changed since the last read.", "Le document a changé depuis la dernière lecture."));
        var inspected = (await InspectDocument(documentId).ConfigureAwait(false))["document"] as JsonObject;
        if (Json.Str(inspected, "stateToken") != expectedStateToken)
            throw Fail("STATE_CONFLICT", Strings.T("The content or structure of the document changed since the last inspection.", "Le contenu ou la structure du document a changé depuis la dernière inspection."));
        return documents;
    }

    // ----- Mutations -------------------------------------------------------------------------------------------------

    public Task<JsonObject> CloseDocument(long documentId, long expectedRevision, string expectedStateToken, bool save)
    {
        if (save) throw Fail("SILENT_CLOSE_SAVE_FORBIDDEN", Strings.T("The silent close forbids any save: save must be false.", "La fermeture silencieuse interdit tout enregistrement : save doit valoir false."));
        string operationId = Json.NewId();
        return WithMutationGuard(operationId, async () =>
        {
            var snapshots = await SnapshotAllDocuments().ConfigureAwait(false);
            var target = snapshots.OfType<JsonObject>().FirstOrDefault(document => Json.Long(document, "documentId") == documentId)
                ?? throw Fail("DOCUMENT_NOT_FOUND", Strings.T("Document to close not found.", "Document à fermer introuvable."));
            if (Json.Long(target, "revision") != expectedRevision) throw Fail("REVISION_CONFLICT", Strings.T("The document changed since the last read.", "Le document a changé depuis la dernière lecture."));
            if (Json.Str(target, "stateToken") != expectedStateToken) throw Fail("STATE_CONFLICT", Strings.T("The document changed since the last inspection.", "Le document a changé depuis la dernière inspection."));
            var inputs = new Inputs()
                .Add("documentId", documentId)
                .Add("expectedRevision", expectedRevision)
                .Add("expectedStateToken", expectedStateToken)
                .Add("expectedDocuments", snapshots);
            return await RunUxpTracked("close-document.js", inputs.Render("close-document.js"), inputs.Values, operationId).ConfigureAwait(false);
        });
    }

    private long ProfileBudgetMs()
    {
        long timeoutMs = (long)Timeout.TotalMilliseconds;
        long margin = Math.Min(10_000, Math.Max(250, timeoutMs / 10));
        return Math.Max(250, timeoutMs - margin);
    }

    public async Task<JsonObject> OpenDocument(string filePath, string? operationId = null)
    {
        if (!Path.IsPathFullyQualified(filePath) || filePath.Contains('\0', StringComparison.Ordinal))
            throw Fail("OPEN_PATH_INVALID", Strings.T("A valid absolute path is required to open the document.", "Un chemin absolu valide est requis pour ouvrir le document."));
        string extension = Path.GetExtension(filePath).ToLowerInvariant();
        string kind = extension switch
        {
            ".indd" => "indd",
            ".idml" => "idml",
            _ => throw Fail("OPEN_EXTENSION_UNSUPPORTED", Strings.T("Only INDD and IDML files can be opened silently.", "Seuls les fichiers INDD et IDML peuvent être ouverts silencieusement.")),
        };
        var before = new FileInfo(filePath);
        if (!before.Exists) throw Fail("OPEN_SOURCE_UNAVAILABLE", Strings.T("The document to open is missing or inaccessible.", "Le document à ouvrir est introuvable ou inaccessible."));
        if (before.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw Fail("OPEN_SOURCE_INVALID", Strings.T("The document to open must be a regular file, never a link.", "Le document à ouvrir doit être un fichier normal, jamais un lien."));
        var verification = ArtifactVerifier.Verify(filePath, kind);
        var after = new FileInfo(filePath);
        if (!after.Exists || after.Length != before.Length || after.LastWriteTimeUtc != before.LastWriteTimeUtc)
            throw Fail("OPEN_SOURCE_CHANGED", Strings.T("The document changed during its validation and was not sent to InDesign.", "Le document a changé pendant sa validation et n’a pas été envoyé à InDesign."));
        operationId ??= Json.NewId();
        var inputs = new Inputs()
            .Add("filePath", UxpTemplates.UxpPath(filePath))
            .Add("profileBudgetMs", ProfileBudgetMs());
        var result = await RunUxpTracked("open-document.js", inputs.Render("open-document.js"), inputs.Values, operationId).ConfigureAwait(false);
        result["artifactVerification"] = verification;
        return result;
    }

    public async Task<JsonObject> CreateDocument(double width, double height, long pageCount, bool facingPages, string units,
        double[] margins, double[] bleed, string? savePath)
    {
        double Mm(double value) => units == "pt" ? value * 25.4 / 72 : value;
        var spec = new JsonObject
        {
            ["width"] = Mm(width), ["height"] = Mm(height), ["pageCount"] = pageCount, ["facingPages"] = facingPages,
            ["margins"] = Json.Array(margins.Select(value => (JsonNode)Mm(value))), ["bleed"] = Json.Array(bleed.Select(value => (JsonNode)Mm(value))),
        };
        var lengths = margins.Concat(bleed).Select(Mm).ToList();
        if (!double.IsFinite(Mm(width)) || Mm(width) <= 0 || !double.IsFinite(Mm(height)) || Mm(height) <= 0 || pageCount is < 1 or > 10_000
            || lengths.Count != 8 || lengths.Any(value => !double.IsFinite(value) || value < 0))
            throw Fail("CREATE_ARGS_INVALID", Strings.T("Invalid dimensions, pages, margins or bleed to create the document.", "Dimensions, pages, marges ou fond perdu invalides pour la création du document."));
        if (savePath is not null)
        {
            if (!Path.IsPathFullyQualified(savePath) || savePath.Contains('\0', StringComparison.Ordinal) || !Path.GetExtension(savePath).Equals(".indd", StringComparison.OrdinalIgnoreCase))
                throw Fail("CREATE_PATH_INVALID", Strings.T("The save path of the new document must be an absolute INDD file.", "Le chemin d’enregistrement du nouveau document doit être un fichier INDD absolu."));
            if (File.Exists(savePath) || Directory.Exists(savePath)) throw Fail("TARGET_EXISTS", Strings.T("A file already exists at this location; creating never overwrites.", "Un fichier existe déjà à cet emplacement ; la création n’écrase rien."));
            if (!Directory.Exists(Path.GetDirectoryName(savePath)))
                throw Fail("CREATE_PATH_PARENT_NOT_FOUND", Strings.T("The save folder must exist before the document is created; no document was created.", "Le dossier d’enregistrement doit exister avant de créer le document ; aucun document n’a été créé."));
        }
        string operationId = Json.NewId();
        var inputs = new Inputs()
            .Add("spec", spec)
            .Add("savePath", savePath is null ? null : UxpTemplates.UxpPath(savePath))
            .Add("profileBudgetMs", ProfileBudgetMs());
        var result = await RunUxpTracked("create-document.js", inputs.Render("create-document.js"), inputs.Values, operationId).ConfigureAwait(false);
        result["executionChannel"] = "silent";
        if (savePath is not null)
        {
            result["path"] = savePath;
            result["artifactVerification"] = ArtifactVerifier.Verify(savePath, "indd");
        }
        return result;
    }

    /// <summary>An export request already validated by the tool contract and the path policy.</summary>
    internal sealed record ExportRequest(string Command, long DocumentId, long ExpectedRevision, string ExpectedStateToken)
    {
        public string? FilePath { get; init; }
        public string? FolderPath { get; init; }
        public long? PageId { get; init; }
        public string PageRange { get; init; } = "all";
        public long Resolution { get; init; } = 300;
        public bool TransparentBackground { get; init; }
        public string? PresetName { get; init; }
        public bool IncludeFonts { get; init; } = true;
        public bool IncludeLinks { get; init; } = true;
        public bool IncludeProfiles { get; init; } = true;
        public bool IncludeHiddenLayers { get; init; }
        public bool IgnorePreflightErrors { get; init; }
        public bool IncludeIdml { get; init; } = true;
        public bool IncludePdf { get; init; } = true;
        public string? PdfPresetName { get; init; }
        /// <summary>PNG only: render from a hidden private copy carrying an annotation layer (the source is untouched).</summary>
        public bool Annotate { get; init; }
    }

    private static bool ValidAbsolute(string? value, string extension) => value is not null && Path.IsPathFullyQualified(value)
        && !value.Contains('\0', StringComparison.Ordinal) && Path.GetExtension(value).Equals(extension, StringComparison.OrdinalIgnoreCase);

    /// <summary>PDF, PNG, IDML or package, after backups of every open document; every document is checked unchanged.</summary>
    public Task<JsonObject> ExportDocument(ExportRequest request, string? operationId = null)
    {
        if (request.Command is not ("export_pdf" or "export_png" or "package_document" or "export_idml"))
            throw Fail("SILENT_EXPORT_UNKNOWN", Strings.T("Unknown silent export type.", "Type d’export silencieux inconnu."));
        if (request.DocumentId < 1) throw Fail("DOCUMENT_ID_INVALID", Strings.T("Invalid document id for the silent export.", "Identifiant de document invalide pour l’export silencieux."));
        if (request.ExpectedRevision < 0) throw Fail("REVISION_INVALID", Strings.T("Invalid revision for the silent export.", "Révision invalide pour l’export silencieux."));
        if (!Json.StateToken().IsMatch(request.ExpectedStateToken)) throw Fail("STATE_TOKEN_REQUIRED", Strings.T("Invalid document state token for the silent export.", "Empreinte documentaire invalide pour l’export silencieux."));
        switch (request.Command)
        {
            case "export_pdf":
                if (!ValidAbsolute(request.FilePath, ".pdf")) throw Fail("EXPORT_PATH_INVALID", Strings.T("A valid absolute PDF path is required.", "Un chemin PDF absolu valide est requis."));
                if (request.PresetName is { Length: < 1 or > 300 }) throw Fail("PDF_PRESET_INVALID", Strings.T("The PDF preset name is invalid.", "Le nom du paramètre PDF est invalide."));
                break;
            case "export_idml":
                if (!ValidAbsolute(request.FilePath, ".idml")) throw Fail("EXPORT_PATH_INVALID", Strings.T("A valid absolute IDML path is required.", "Un chemin IDML absolu valide est requis."));
                break;
            case "package_document":
                if (request.FolderPath is null || !Path.IsPathFullyQualified(request.FolderPath) || request.FolderPath.Contains('\0', StringComparison.Ordinal))
                    throw Fail("PACKAGE_TARGET_INVALID", Strings.T("A valid absolute package folder is required.", "Un dossier d’assemblage absolu valide est requis."));
                if (request.PdfPresetName is { Length: < 1 or > 300 }) throw Fail("PACKAGE_OPTIONS_INVALID", Strings.T("The package options are invalid.", "Les paramètres de l’assemblage sont invalides."));
                break;
            default:
                bool single = request.PageId is > 0;
                if (single != ValidAbsolute(request.FilePath, ".png") || single == (request.FolderPath is not null))
                    throw Fail("PNG_TARGET_INVALID", Strings.T("The PNG export needs either pageId with filePath, or folderPath alone.", "L’export PNG exige soit pageId avec filePath, soit folderPath seul."));
                if (!single && (!Path.IsPathFullyQualified(request.FolderPath!) || request.FolderPath!.Contains('\0', StringComparison.Ordinal)))
                    throw Fail("PNG_TARGET_INVALID", Strings.T("A valid absolute PNG folder is required.", "Un dossier PNG absolu valide est requis."));
                if (request.Resolution is < 36 or > 2400) throw Fail("PNG_RESOLUTION_INVALID", Strings.T("The PNG resolution must be between 36 and 2400 ppi.", "La résolution PNG doit être comprise entre 36 et 2400 ppp."));
                if (request.PageRange.Length is < 1 or > 128) throw Fail("PNG_OPTIONS_INVALID", Strings.T("The PNG export options are invalid.", "Les paramètres de l’export PNG sont invalides."));
                break;
        }
        operationId ??= activeOperation.Value ?? Json.NewId();
        return WithMutationGuard(operationId, async () =>
        {
            var documents = await ExpectState(request.DocumentId, request.ExpectedRevision, request.ExpectedStateToken, Strings.T("Document not found before the silent export.", "Document introuvable avant l’export silencieux.")).ConfigureAwait(false);
            var safetyBackups = new JsonArray();
            string? annotatedCopy = null;
            try
            {
                safetyBackups = await BackupDocuments(documents).ConfigureAwait(false);
                var expected = ExpectedDocuments(safetyBackups);
                var action = new Inputs();
                string actionTemplate;
                switch (request.Command)
                {
                    case "package_document":
                        actionTemplate = "package-action.js";
                        action.Add("options", new JsonObject
                        {
                            ["folderPath"] = UxpTemplates.UxpPath(request.FolderPath!), ["includeFonts"] = request.IncludeFonts,
                            ["includeLinks"] = request.IncludeLinks, ["includeProfiles"] = request.IncludeProfiles,
                            ["includeHiddenLayers"] = request.IncludeHiddenLayers, ["ignorePreflightErrors"] = request.IgnorePreflightErrors,
                            ["includeIdml"] = request.IncludeIdml, ["includePdf"] = request.IncludePdf, ["pdfPresetName"] = request.PdfPresetName ?? "",
                        });
                        break;
                    case "export_pdf":
                        actionTemplate = "export-pdf-action.js";
                        action.Add("presetName", request.PresetName).Add("filePath", UxpTemplates.UxpPath(request.FilePath!));
                        break;
                    case "export_idml":
                        actionTemplate = "export-idml-action.js";
                        action.Add("filePath", UxpTemplates.UxpPath(request.FilePath!));
                        break;
                    default:
                        actionTemplate = "export-png-action.js";
                        if (request.Annotate)
                        {
                            string source = Json.Str(safetyBackups.OfType<JsonObject>().FirstOrDefault(backup => Json.Long(backup, "documentId") == request.DocumentId), "backupPath")
                                ?? throw Fail("ANNOTATED_COPY_UNAVAILABLE", Strings.T("The backup of the document to annotate is missing.", "La sauvegarde du document à annoter est introuvable."));
                            annotatedCopy = Path.Combine(RuntimeDirectory, $"annotate-{operationId}.indd");
                            File.Copy(source, annotatedCopy, overwrite: false);
                        }
                        action.Add("annotateCopyPath", annotatedCopy is null ? null : UxpTemplates.UxpPath(annotatedCopy));
                        action.Add("folderPath", request.FolderPath is null ? null : UxpTemplates.UxpPath(request.FolderPath))
                            .Add("filePath", request.FilePath is null ? null : UxpTemplates.UxpPath(request.FilePath))
                            .Add("pageId", request.PageId)
                            .Add("pageRange", request.PageRange)
                            .Add("resolution", request.Resolution)
                            .Add("transparentBackground", request.TransparentBackground);
                        break;
                }
                var inputs = new Inputs()
                    .Add("documentId", request.DocumentId)
                    .Add("expectedRevision", request.ExpectedRevision)
                    .Add("expectedStateToken", request.ExpectedStateToken)
                    .Add("expectedDocuments", expected)
                    .Fragment("exportAction", action.Render(actionTemplate).TrimEnd('\n'));
                inputs.Values["action"] = actionTemplate;
                inputs.Values["actionInputs"] = action.Values.DeepClone();
                var result = await RunUxpTracked("export-document.js", inputs.Render("export-document.js"), inputs.Values, operationId).ConfigureAwait(false);
                var after = await SnapshotAllDocuments().ConfigureAwait(false);
                AssertStableSnapshots(expected, after, Strings.T("A document changed during the silent export.", "Un document a changé pendant l’export silencieux."));
                result["safetyBackups"] = safetyBackups.DeepClone();
                return result;
            }
            catch (Exception exception)
            {
                throw ToolError.From(exception).WithBackups(safetyBackups, request.DocumentId);
            }
            finally
            {
                if (annotatedCopy is not null) DeleteQuietly(annotatedCopy);
            }
        });
    }

    /// <summary>save_document (savePath null) or save_as: backups first, the other documents checked unchanged.</summary>
    public Task<JsonObject> SaveDocument(long documentId, long expectedRevision, string expectedStateToken, string? savePath, string? operationId = null)
    {
        if (savePath is not null && !ValidAbsolute(savePath, ".indd")) throw Fail("SAVE_PATH_INVALID", Strings.T("A valid absolute INDD path is required.", "Un chemin INDD absolu valide est requis."));
        operationId ??= activeOperation.Value ?? Json.NewId();
        return WithMutationGuard(operationId, async () =>
        {
            var documents = await ExpectState(documentId, expectedRevision, expectedStateToken, Strings.T("Document not found before saving.", "Document introuvable avant l’enregistrement.")).ConfigureAwait(false);
            var safetyBackups = new JsonArray();
            try
            {
                safetyBackups = await BackupDocuments(documents).ConfigureAwait(false);
                var inputs = new Inputs()
                    .Add("documentId", documentId)
                    .Add("expectedRevision", expectedRevision)
                    .Add("expectedStateToken", expectedStateToken)
                    .Add("expectedDocuments", ExpectedDocuments(safetyBackups))
                    .Add("savePath", savePath is null ? null : UxpTemplates.UxpPath(savePath));
                var result = await RunUxpTracked("save-document.js", inputs.Render("save-document.js"), inputs.Values, operationId).ConfigureAwait(false);
                result["safetyBackups"] = safetyBackups.DeepClone();
                return result;
            }
            catch (Exception exception)
            {
                throw ToolError.From(exception).WithBackups(safetyBackups, documentId);
            }
        });
    }

    public Task<JsonObject> ExecuteDocument(long documentId, long expectedRevision, string expectedStateToken, string code, JsonNode? input, string? reason = null)
    {
        string operationId = Json.NewId();
        return WithMutationGuard(operationId, async () =>
        {
            var documents = await ExpectState(documentId, expectedRevision, expectedStateToken, Strings.T("Document not found before the backup.", "Document introuvable avant sauvegarde.")).ConfigureAwait(false);
            var safetyBackups = await BackupDocuments(documents).ConfigureAwait(false);
            var inputs = new Inputs()
                .Add("documentId", documentId)
                .Add("expectedRevision", expectedRevision)
                .Add("expectedStateToken", expectedStateToken)
                .Add("expectedDocuments", ExpectedDocuments(safetyBackups))
                .Add("input", input)
                .Add("code", code)
                .Add("undoName", UndoName(reason));
            try
            {
                var result = await RunUxpTracked("execute-document.js", inputs.Render("execute-document.js"), inputs.Values, operationId).ConfigureAwait(false);
                result["safetyBackups"] = safetyBackups.DeepClone();
                return result;
            }
            catch (Exception exception)
            {
                var error = ToolError.From(exception);
                error.SafetyBackups = safetyBackups;
                error.BackupId = null;
                error.BackupPath = null;
                throw error.WithBackups(safetyBackups, documentId);
            }
        });
    }

    /// <summary>
    /// The fast path: state check, backups of every open document, the script, optional save, a PNG preview and optional
    /// close, in one tracked UXP pass. A failing script is a known outcome: returned with the backups, never blocking.
    /// </summary>
    public Task<JsonObject> RunLayoutScript(long documentId, long expectedRevision, string expectedStateToken, string code, JsonNode? input,
        bool save, bool close, string? previewPages, long previewResolution, string? reason = null)
    {
        if (close && !save) throw Fail("CLOSE_REQUIRES_SAVE", Strings.T("close needs save=true: closing without saving would lose the script's work.", "close exige save=true : fermer sans enregistrer perdrait le travail du script."));
        string operationId = Json.NewId();
        return WithMutationGuard(operationId, async () =>
        {
            var slots = Enumerable.Range(0, FastBackupSlots).Select(_ =>
            {
                string backupId = Json.NewId();
                return (BackupId: backupId, BackupPath: BackupPathFor(backupId));
            }).ToList();
            string previewDirectory = Path.Combine(BackupDirectory, "previews");
            Directory.CreateDirectory(previewDirectory);
            string previewPath = Path.Combine(previewDirectory, $"{operationId}.png");
            var inputs = new Inputs()
                .Add("documentId", documentId)
                .Add("expectedRevision", expectedRevision)
                .Add("expectedStateToken", expectedStateToken)
                .Add("slots", Json.Array(slots.Select(slot => (JsonNode)UxpTemplates.UxpPath(slot.BackupPath))))
                .Add("input", input)
                .Add("code", code)
                .Add("undoName", UndoName(reason))
                .Add("save", save)
                .Add("close", close)
                .Add("previewResolution", previewResolution)
                .Add("previewPath", UxpTemplates.UxpPath(previewPath))
                .Fragment("previewPages", previewPages is null ? "String(target.doc.pages.item(0).name)" : Json.Literal(previewPages));
            inputs.Values["previewPages"] = previewPages;
            var outcome = await RunUxpTracked("run-layout-script.js", inputs.Render("run-layout-script.js"), inputs.Values, operationId).ConfigureAwait(false);
            var safetyBackups = new JsonArray();
            foreach (var backup in (outcome["backups"] as JsonArray ?? []).OfType<JsonObject>())
            {
                long slotIndex = Json.Long(backup, "slot") ?? -1;
                if (slotIndex < 0 || slotIndex >= slots.Count)
                    throw Fail("BACKUP_RESPONSE_MISMATCH", Strings.T("The quick backup matches no locally signed location.", "La sauvegarde rapide ne correspond à aucun emplacement signé localement."));
                var slot = slots[(int)slotIndex];
                long backupDocumentId = Json.Long(backup, "documentId") ?? 0, revision = Json.Long(backup, "revision") ?? -1;
                string token = Json.Str(backup, "stateToken") ?? "";
                var metadata = WriteBackupMetadata(slot.BackupId, slot.BackupPath, backupDocumentId, revision, token);
                safetyBackups.Add(new JsonObject
                {
                    ["documentId"] = backupDocumentId, ["revision"] = revision, ["stateToken"] = token, ["backupId"] = slot.BackupId,
                    ["backupPath"] = slot.BackupPath, ["metadataPath"] = metadata["metadataPath"]?.DeepClone(),
                    ["artifactSha256"] = metadata["artifact"]?["sha256"]?.DeepClone(),
                    ["method"] = Json.Str(backup, "method") == "copy" ? "copy" : "saveACopy",
                });
            }
            var previews = Directory.EnumerateFiles(previewDirectory, $"{operationId}*.png").Order(StringComparer.Ordinal).ToList();
            foreach (string file in previews) ArtifactVerifier.Verify(file, "png");
            outcome.Remove("backups");
            outcome["previewPaths"] = Json.Array(previews.Select(file => (JsonNode)file));
            outcome["safetyBackups"] = safetyBackups;
            Json.SetIfNotNull(outcome, "backupId", Json.Str(safetyBackups.OfType<JsonObject>().FirstOrDefault(entry => Json.Long(entry, "documentId") == documentId), "backupId"));
            if (!Json.IsTrue(outcome, "scriptOk"))
            {
                // Same convention as a failed call: partial when the script changed a document before failing.
                bool changed = (outcome["revisions"] as JsonArray)?.Count > 0;
                outcome["requiresInspection"] = true;
                outcome["outcome"] = changed ? "partial" : "not_done";
                outcome["retry_safe"] = !changed;
                outcome["nextStep"] = changed
                    ? Strings.T("The script failed after changing the document: check the preview, fix it and run again, or restore with silent_restore_backup and backupId (its changes form a single InDesign undo step).", "Le script a échoué après avoir modifié le document : relisez l’aperçu, corrigez puis relancez, ou restaurez avec silent_restore_backup et backupId (ses modifications forment une seule étape d’annulation InDesign).")
                    : Strings.T("The script failed without changing the document: fix it and run again (silent_restore_backup with backupId can restore).", "Le script a échoué sans modifier le document : corrigez puis relancez (restauration possible avec silent_restore_backup et backupId).");
            }
            return outcome;
        });
    }

    /// <summary>The name of the script's single undo step in InDesign's Edit menu.</summary>
    internal static string UndoName(string? reason)
    {
        string text = System.Text.RegularExpressions.Regex.Replace(reason ?? "", @"\s+", " ").Trim();
        if (text.Length == 0) text = "script";
        return "Nexus : " + (text.Length > 100 ? text[..99] + "…" : text);
    }

    public async Task<JsonObject> RestoreBackup(long documentId, long expectedRevision, string expectedStateToken, string backupId)
    {
        if (!Json.BackupId().IsMatch(backupId)) throw Fail("BACKUP_ID_INVALID", Strings.T("Invalid silent backup id.", "Identifiant de sauvegarde silencieuse invalide."));
        string backupPath = BackupPathFor(backupId);
        var metadata = ReadBackupMetadata(backupId, backupPath, documentId);
        string operationId = Json.NewId();
        return await WithMutationGuard(operationId, async () =>
        {
            var documents = await ExpectState(documentId, expectedRevision, expectedStateToken, Strings.T("Document to restore not found.", "Document à restaurer introuvable.")).ConfigureAwait(false);
            var recoveryBackups = await BackupDocuments(documents).ConfigureAwait(false);
            string restoredDirectory = Path.Combine(BackupDirectory, "restored");
            Directory.CreateDirectory(restoredDirectory);
            if (!IsRegularDirectory(restoredDirectory)) throw Fail("RESTORED_DIRECTORY_INVALID", Strings.T("The private folder of restored copies is invalid.", "Le dossier privé des copies restaurées est invalide."));
            Protect(restoredDirectory, directory: true);
            string id = Json.NewId();
            string workingPath = Path.Combine(restoredDirectory, $"restore-{id}.indd");
            string markerPath = Path.Combine(restoredDirectory, $"restore-{id}.open.json");
            WritePrivateNewFile(markerPath, new JsonObject
            {
                ["schemaVersion"] = 1, ["operationId"] = operationId, ["backupId"] = backupId, ["workingFile"] = Path.GetFileName(workingPath),
                ["status"] = "reserved-or-open", ["createdAt"] = DateTime.UtcNow.ToString("o"),
            }.ToJsonString(Json.Compact));
            try
            {
                File.Copy(backupPath, workingPath, overwrite: false);
                ValidateBackupArtifact(workingPath);
            }
            catch
            {
                DeleteQuietly(workingPath);
                DeleteQuietly(markerPath);
                throw;
            }
            var inputs = new Inputs()
                .Add("documentId", documentId)
                .Add("expectedRevision", expectedRevision)
                .Add("expectedStateToken", expectedStateToken)
                .Add("expectedDocuments", ExpectedDocuments(recoveryBackups))
                .Add("restoredWorkingPath", UxpTemplates.UxpPath(workingPath));
            try
            {
                var result = await RunUxpTracked("restore-backup.js", inputs.Render("restore-backup.js"), inputs.Values, operationId).ConfigureAwait(false);
                result["restoredFromBackupId"] = backupId;
                result["restoredSourceRevision"] = metadata["revision"]?.DeepClone();
                result["restoredSourceStateToken"] = metadata["stateToken"]?.DeepClone();
                result["restoredWorkingPath"] = workingPath;
                result["recoveryBackups"] = recoveryBackups.DeepClone();
                return result;
            }
            catch (Exception exception)
            {
                var error = ToolError.From(exception);
                error.SafetyBackups = recoveryBackups;
                error.BackupId = null;
                error.BackupPath = null;
                error.WithBackups(recoveryBackups, documentId);
                if (!error.RequiresInspection)
                {
                    DeleteQuietly(workingPath);
                    DeleteQuietly(markerPath);
                }
                throw error;
            }
        }).ConfigureAwait(false);
    }

    /// <summary>
    /// A working copy: the source backed up (saveACopy), the copy written to the target (the existing target saved
    /// first by the caller) and opened silently, the source proven unchanged before and after.
    /// </summary>
    public Task<JsonObject> CreateWorkingCopy(long documentId, long expectedRevision, string expectedStateToken, string targetPath,
        Func<JsonObject> protectTarget, string? operationId = null)
    {
        operationId ??= activeOperation.Value ?? Json.NewId();
        string op = operationId;
        return WithMutationGuard(op, async () =>
        {
            var before = (await InspectDocument(documentId).ConfigureAwait(false))["document"] as JsonObject;
            if (before is null || Json.Long(before, "revision") != expectedRevision)
                throw Fail("REVISION_CONFLICT", Strings.T("The source document changed before the working copy was created.", "Le document source a changé avant la création de la copie de travail."));
            if (Json.Str(before, "stateToken") != expectedStateToken)
                throw Fail("STATE_CONFLICT", Strings.T("The content of the source document changed before the working copy was created.", "Le contenu du document source a changé avant la création de la copie de travail."));
            var targetProtection = protectTarget();
            string backupId = Json.NewId();
            string backupPath = BackupPathFor(backupId);
            await CreateBackup(documentId, expectedRevision, backupPath, backupId).ConfigureAwait(false);
            var afterBackup = (await InspectDocument(documentId).ConfigureAwait(false))["document"] as JsonObject;
            if (Json.Long(afterBackup, "revision") != expectedRevision || Json.Str(afterBackup, "stateToken") != expectedStateToken)
                throw Fail("STATE_CONFLICT", Strings.T("The source document changed during its safety backup.", "Le document source a changé pendant sa sauvegarde de sécurité."));
            var metadata = WriteBackupMetadata(backupId, backupPath, documentId, expectedRevision, expectedStateToken);
            bool copied = false, opened = false;
            string? targetBackupPath = Json.Str(targetProtection, "targetBackupPath");
            try
            {
                if (targetBackupPath is not null) File.Delete(targetPath);
                File.Copy(backupPath, targetPath, overwrite: false);
                copied = true;
                var verification = ArtifactVerifier.Verify(targetPath, "indd");
                var open = await OpenDocument(targetPath, op).ConfigureAwait(false);
                opened = true;
                var after = (await InspectDocument(documentId).ConfigureAwait(false))["document"] as JsonObject;
                if (Json.Long(after, "revision") != expectedRevision || Json.Str(after, "stateToken") != expectedStateToken)
                    throw new ToolError("WORKING_COPY_SOURCE_CHANGED", Strings.T("The source document changed while the working copy was created.", "Le document source a changé pendant la création de la copie de travail."), true) { PartialOutputPath = targetPath };
                var output = new JsonObject
                {
                    ["success"] = true, ["sourceDocumentId"] = documentId, ["sourceRevision"] = expectedRevision,
                    ["sourceStateToken"] = expectedStateToken, ["sourceUnchanged"] = true,
                    ["workingDocumentId"] = open["documentId"]?.DeepClone(), ["workingRevision"] = open["revision"]?.DeepClone(),
                    ["workingStateToken"] = open["stateToken"]?.DeepClone(), ["workingCopyPath"] = targetPath,
                    ["backupId"] = backupId, ["backupPath"] = backupPath, ["backupMetadataPath"] = metadata["metadataPath"]?.DeepClone(),
                    ["backupArtifactSha256"] = metadata["artifact"]?["sha256"]?.DeepClone(), ["artifactVerification"] = verification,
                };
                return Json.Merge(output, targetProtection);
            }
            catch (Exception exception)
            {
                var error = ToolError.From(exception);
                error.BackupId ??= backupId;
                error.BackupPath ??= backupPath;
                error.TargetBackupId ??= Json.Str(targetProtection, "targetBackupId");
                error.TargetBackupPath ??= targetBackupPath;
                if (error.RequiresInspection || opened) error.PartialOutputPath ??= targetPath;
                else
                {
                    if (copied) DeleteQuietly(targetPath);
                    if (targetBackupPath is not null && !File.Exists(targetPath))
                    {
                        try { File.Copy(targetBackupPath, targetPath); } catch (IOException) { }
                    }
                }
                throw error;
            }
        });
    }
}
