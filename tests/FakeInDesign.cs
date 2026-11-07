using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using NexusInDesign.InDesign;

namespace NexusInDesign.Tests;

/// <summary>
/// InDesign as seen by the engine, in memory: each template is emulated from its inputs, results go where InDesign's
/// script would put them (DoScript value or result file). Files that InDesign would write are written for real.
/// </summary>
internal sealed class FakeInDesign : IInDesignHost
{
    internal sealed class Document
    {
        public long Id { get; init; }
        public string Name { get; set; } = "";
        public long Revision { get; set; }
        public int Version { get; set; }
        public bool Saved { get; set; }
        public bool Modified { get; set; }
        public string? Path { get; set; }
        public int Pages { get; set; } = 2;
    }

    private long nextId = 100;
    private int holds;

    public List<Document> Documents { get; } = [];
    public long? ActiveId { get; set; }
    public bool Modal { get; set; }
    public List<ScriptRun> Runs { get; } = [];
    public List<HostProcess> Hosts { get; } = [new HostProcess(4242, DateTime.UtcNow.AddHours(-1), true)];
    /// <summary>Template whose next tracked run hands InDesign the script but never writes its result.</summary>
    public string? LoseResultOf { get; set; }
    public JsonArray? PreflightFindings { get; set; }
    public int ActiveHolds => holds;

    public static string Token(Document document) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{document.Id}|{document.Version}|{document.Saved}|{document.Modified}|{document.Path}")))[..16];

    public Document Add(string name, string? path = null, long revision = 0)
    {
        var document = new Document { Id = nextId++, Name = name, Path = path, Saved = path is not null, Revision = revision };
        Documents.Add(document);
        ActiveId = document.Id;
        return document;
    }

    public IReadOnlyList<HostProcess> Processes() => Hosts.ToList();

    public Task<IAsyncDisposable> HoldAsync(string operationId)
    {
        Interlocked.Increment(ref holds);
        return Task.FromResult<IAsyncDisposable>(new Release(this));
    }

    private sealed class Release(FakeInDesign owner) : IAsyncDisposable
    {
        private int done;
        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref done, 1) == 0) Interlocked.Decrement(ref owner.holds);
            return ValueTask.CompletedTask;
        }
    }

    private static string Native(string? uxpPath) => uxpPath!.Replace('/', '\\');

    private static JsonObject State(Document document) => new()
    {
        ["documentId"] = document.Id, ["revision"] = document.Revision, ["stateToken"] = Token(document),
    };

    private JsonArray States() => Json.Array(Documents.OrderBy(entry => entry.Id).Select(entry => (JsonNode)State(entry)));

    private Document? Find(JsonObject inputs) => Documents.FirstOrDefault(document => document.Id == Json.Long(inputs, "documentId"));

    private static JsonObject Failure(string code, string message, bool inspect = false) =>
        new() { ["ok"] = false, ["code"] = code, ["message"] = message, ["requiresInspection"] = inspect };

    private bool ExpectedDocumentsMatch(JsonObject inputs)
    {
        var expected = (inputs["expectedDocuments"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        return expected.Count == Documents.Count && Documents.All(document => expected.Any(entry =>
            Json.Long(entry, "documentId") == document.Id && Json.Long(entry, "revision") == document.Revision && Json.Str(entry, "stateToken") == Token(document)));
    }

    public Task<string?> RunAsync(ScriptRun run)
    {
        run.Guard?.Invoke();
        Runs.Add(run);
        string source = File.ReadAllText(run.ScriptPath);
        if (source.Contains("@@", StringComparison.Ordinal)) throw new InvalidOperationException($"{run.Template}: unresolved template input.");
        var inputs = run.Inputs;
        JsonObject? result = run.Template switch
        {
            "status.js" => new JsonObject
            {
                ["ok"] = true, ["mode"] = "silent-com-uxp", ["application"] = "Adobe InDesign", ["version"] = "21.0", ["modalState"] = Modal,
                ["openDocuments"] = Documents.Count, ["capabilities"] = new JsonObject { ["silentOpen"] = true },
            },
            "list-documents.js" => new JsonObject
            {
                ["ok"] = true,
                ["documents"] = Json.Array(Documents.Select(document => (JsonNode)new JsonObject
                {
                    ["documentId"] = document.Id, ["name"] = document.Name, ["pages"] = document.Pages, ["modified"] = document.Modified,
                    ["revision"] = document.Revision, ["active"] = document.Id == ActiveId,
                })),
            },
            "inspect-document.js" => Find(inputs) is { } doc
                ? new JsonObject
                {
                    ["ok"] = true,
                    ["document"] = new JsonObject
                    {
                        ["documentId"] = doc.Id, ["name"] = doc.Name, ["pages"] = doc.Pages, ["spreads"] = 1, ["pageItems"] = 0, ["width"] = 210, ["height"] = 297,
                        ["facingPages"] = true, ["modified"] = doc.Modified, ["saved"] = doc.Saved, ["revision"] = doc.Revision, ["stateToken"] = Token(doc),
                    },
                }
                : Failure("DOCUMENT_NOT_FOUND", "Document introuvable"),
            "audit-document.js" => Audit(inputs),
            "restored-paths.js" => new JsonObject
            {
                ["ok"] = true, ["pathsReadable"] = true,
                ["openPaths"] = Json.Array(Documents.Where(document => document.Path is not null).Select(document => (JsonNode)document.Path!)),
            },
            "preflight.js" => Find(inputs) is { } target
                ? new JsonObject
                {
                    ["ok"] = true, ["success"] = true, ["profile"] = "[Basique]",
                    ["aggregatedResults"] = new JsonArray(target.Name, "[Basique]", PreflightFindings?.DeepClone() ?? new JsonArray()),
                    ["processResults"] = "Aucun", ["documentId"] = target.Id, ["revision"] = target.Revision,
                }
                : Failure("DOCUMENT_NOT_FOUND", "Document introuvable"),
            "create-backup.jsx" => null,
            "open-document.js" => Open(inputs),
            "create-document.js" => Create(inputs),
            "close-document.js" => Close(inputs),
            "export-document.js" => Export(inputs),
            "save-document.js" => Save(inputs),
            "execute-document.js" => Execute(inputs),
            "run-layout-script.js" => Layout(inputs),
            "restore-backup.js" => Restore(inputs),
            _ => throw new InvalidOperationException($"Unknown template {run.Template}"),
        };
        if (run.Template == "create-backup.jsx") return Task.FromResult<string?>(Backup(inputs));
        if (run.CompletionPath is null) return Task.FromResult<string?>(result!.ToJsonString());
        if (LoseResultOf == run.Template)
        {
            LoseResultOf = null;
            throw new ToolError("UXP_OUTCOME_UNKNOWN", "Le délai du résultat UXP asynchrone est dépassé ; issue indéterminée.", true);
        }
        if (result!["operationId"] is null && Json.Str(inputs, "operationId") is null) { }
        File.WriteAllText(run.CompletionPath, result.ToJsonString());
        return Task.FromResult<string?>(null);
    }

    private string Backup(JsonObject inputs)
    {
        var document = Find(inputs);
        if (document is null) return "ERR|DOCUMENT_NOT_FOUND|Document introuvable";
        if (document.Revision != Json.Long(inputs, "expectedRevision")) return "ERR|REVISION_CONFLICT|Le document a change depuis la derniere lecture";
        Samples.WriteIndd(Native(Json.Str(inputs, "backupPath")), $"{document.Id}:{document.Version}");
        return $"OK|{Json.Str(inputs, "backupId")}|{document.Id}|{document.Revision}";
    }

    private JsonObject Audit(JsonObject inputs)
    {
        if (Find(inputs) is not { } doc) return Failure("DOCUMENT_NOT_FOUND", "Document introuvable");
        bool pages = Json.IsTrue(inputs, "includePages");
        return new JsonObject
        {
            ["ok"] = true,
            ["audit"] = new JsonObject
            {
                ["success"] = true, ["documentId"] = doc.Id, ["revision"] = doc.Revision, ["capturedAt"] = DateTime.UtcNow.ToString("o"),
                ["stateToken"] = Token(doc),
                ["document"] = new JsonObject
                {
                    ["id"] = doc.Id, ["name"] = doc.Name, ["path"] = doc.Path, ["modified"] = doc.Modified, ["pageCount"] = doc.Pages, ["spreadCount"] = 1,
                    ["facingPages"] = true, ["widthMm"] = 210, ["heightMm"] = 297,
                },
                ["counts"] = new JsonObject { ["pages"] = doc.Pages, ["spreads"] = 1, ["layers"] = 1, ["masterSpreads"] = 1 },
                ["pages"] = pages
                    ? Json.Array(Enumerable.Range(0, doc.Pages).Select(index => (JsonNode)new JsonObject
                    {
                        ["id"] = 1000 + index, ["index"] = index, ["name"] = (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture),
                        ["bounds"] = new JsonArray(0, 0, 297, 210), ["widthMm"] = 210, ["heightMm"] = 297,
                        ["margins"] = new JsonObject { ["top"] = 12, ["left"] = 12, ["bottom"] = 12, ["right"] = 12 },
                    }))
                    : new JsonArray(),
                ["items"] = Json.IsTrue(inputs, "includeItems")
                    ? new JsonArray(new JsonObject { ["id"] = 5000 + doc.Version, ["type"] = "TextFrame", ["pageId"] = 1000, ["bounds"] = new JsonArray(20, 20, 60, 120), ["overflows"] = false })
                    : new JsonArray(),
                ["links"] = new JsonArray(), ["fonts"] = new JsonArray(), ["images"] = new JsonArray(),
                ["oversetText"] = new JsonObject { ["count"] = 0, ["frames"] = new JsonArray() },
                ["designSystem"] = new JsonObject
                {
                    ["layers"] = new JsonArray(new JsonObject { ["name"] = "Calque 1" }), ["swatches"] = new JsonArray(),
                    ["paragraphStyles"] = new JsonArray(), ["characterStyles"] = new JsonArray(), ["objectStyles"] = new JsonArray(),
                },
                ["totalItems"] = 1, ["inspectedItems"] = 1, ["truncated"] = false,
            },
        };
    }

    private JsonObject Open(JsonObject inputs)
    {
        if (Modal) return Failure("INDESIGN_MODAL", "InDesign affiche une boîte de dialogue modale");
        string path = Native(Json.Str(inputs, "filePath"));
        var existing = Documents.FirstOrDefault(document => string.Equals(document.Path, path, StringComparison.OrdinalIgnoreCase));
        var opened = existing ?? Add(System.IO.Path.GetFileName(path), path);
        ActiveId = opened.Id;
        return new JsonObject
        {
            ["ok"] = true, ["success"] = true, ["documentId"] = opened.Id, ["name"] = opened.Name, ["revision"] = opened.Revision,
            ["stateToken"] = Token(opened), ["alreadyOpen"] = existing is not null, ["activeDocumentId"] = opened.Id, ["documentStates"] = States(),
        };
    }

    private JsonObject Create(JsonObject inputs)
    {
        string? path = Json.Str(inputs, "savePath") is { } uxp ? Native(uxp) : null;
        var created = Add("Sans titre-1");
        created.Pages = (int)(Json.Long(inputs["spec"], "pageCount") ?? 1);
        if (path is not null)
        {
            Samples.WriteIndd(path, "created");
            created.Path = path;
            created.Saved = true;
            created.Name = System.IO.Path.GetFileName(path);
        }
        return new JsonObject
        {
            ["ok"] = true, ["success"] = true, ["documentId"] = created.Id, ["name"] = created.Name, ["revision"] = 0, ["stateToken"] = Token(created),
            ["saved"] = path is not null, ["activeDocumentId"] = created.Id, ["documentStates"] = States(),
        };
    }

    private JsonObject Close(JsonObject inputs)
    {
        if (!ExpectedDocumentsMatch(inputs)) return Failure("DOCUMENT_STATE_CONFLICT", "Un document a changé avant la fermeture");
        var target = Find(inputs)!;
        Documents.Remove(target);
        ActiveId = Documents.LastOrDefault()?.Id;
        return new JsonObject
        {
            ["ok"] = true, ["success"] = true, ["closedDocumentId"] = target.Id, ["saved"] = false, ["activeDocumentId"] = ActiveId, ["documentStates"] = States(),
        };
    }

    private JsonObject Export(JsonObject inputs)
    {
        if (!ExpectedDocumentsMatch(inputs)) return Failure("DOCUMENT_STATE_CONFLICT", "Un document a changé pendant l’export", true);
        var target = Find(inputs)!;
        var action = inputs["actionInputs"] as JsonObject ?? [];
        JsonObject exportResult;
        switch (Json.Str(inputs, "action"))
        {
            case "export-pdf-action.js":
                Samples.WritePdf(Native(Json.Str(action, "filePath")));
                exportResult = new JsonObject { ["success"] = true, ["path"] = Json.Str(action, "filePath"), ["pageRange"] = "all" };
                break;
            case "export-idml-action.js":
                Samples.WriteIdml(Native(Json.Str(action, "filePath")));
                exportResult = new JsonObject { ["success"] = true, ["path"] = Json.Str(action, "filePath") };
                break;
            case "package-action.js":
            {
                string folder = Native(Json.Str(action["options"], "folderPath"));
                Samples.WriteIndd(System.IO.Path.Combine(folder, target.Name.EndsWith(".indd", StringComparison.Ordinal) ? target.Name : target.Name + ".indd"));
                File.WriteAllText(System.IO.Path.Combine(folder, "Instructions.txt"), "Assemblage");
                exportResult = new JsonObject { ["success"] = true, ["folderPath"] = Json.Str(action["options"], "folderPath") };
                break;
            }
            default:
            {
                var paths = new JsonArray();
                if (Json.Str(action, "filePath") is { } single)
                {
                    Samples.WritePng(Native(single));
                    paths.Add(single);
                }
                else
                {
                    string folder = Json.Str(action, "folderPath")!;
                    string range = Json.Str(action, "pageRange") ?? "all";
                    var pages = range == "all" ? Enumerable.Range(1, target.Pages) : range.Split(',').Select(int.Parse);
                    foreach (int page in pages)
                    {
                        string path = $"{folder.TrimEnd('/')}/page-{page:D4}.png";
                        Samples.WritePng(Native(path));
                        paths.Add(path);
                    }
                }
                exportResult = new JsonObject { ["success"] = true, ["paths"] = paths, ["resolution"] = Json.Long(action, "resolution") };
                break;
            }
        }
        return new JsonObject { ["ok"] = true, ["result"] = exportResult, ["documentId"] = target.Id, ["revision"] = target.Revision, ["stateToken"] = Token(target) };
    }

    private JsonObject Save(JsonObject inputs)
    {
        if (!ExpectedDocumentsMatch(inputs)) return Failure("DOCUMENT_STATE_CONFLICT", "Un document a changé après les sauvegardes");
        var target = Find(inputs)!;
        string? path = Json.Str(inputs, "savePath") is { } uxp ? Native(uxp) : null;
        if (path is null && !target.Saved) return Failure("SAVE_AS_REQUIRED", "Le document n’a jamais été enregistré : utilisez save_as");
        if (path is not null)
        {
            target.Path = path;
            target.Name = System.IO.Path.GetFileName(path);
        }
        Samples.WriteIndd(target.Path!, $"saved:{target.Version}");
        target.Saved = true;
        target.Modified = false;
        return new JsonObject
        {
            ["ok"] = true, ["result"] = new JsonObject { ["success"] = true, ["saved"] = true, ["path"] = Json.Str(inputs, "savePath") },
            ["documentId"] = target.Id, ["revision"] = target.Revision, ["stateToken"] = Token(target),
        };
    }

    private JsonObject Execute(JsonObject inputs)
    {
        if (!ExpectedDocumentsMatch(inputs)) return Failure("DOCUMENT_STATE_CONFLICT", "Un document a changé après les sauvegardes");
        var target = Find(inputs)!;
        var revisions = new JsonArray();
        foreach (var document in Documents)
        {
            document.Revision++;
            revisions.Add(new JsonObject { ["documentId"] = document.Id, ["revision"] = document.Revision });
        }
        target.Version++;
        target.Modified = true;
        return new JsonObject
        {
            ["ok"] = true, ["result"] = Json.Str(inputs, "code") == "return 42;" ? 42 : null, ["documentId"] = target.Id,
            ["revision"] = target.Revision, ["revisions"] = revisions, ["stateToken"] = Token(target),
        };
    }

    private JsonObject Layout(JsonObject inputs)
    {
        if (Modal) return Failure("INDESIGN_MODAL", "InDesign affiche une boîte de dialogue modale");
        var target = Find(inputs);
        if (target is null) return Failure("DOCUMENT_NOT_FOUND", "Document introuvable");
        if (target.Revision != Json.Long(inputs, "expectedRevision")) return Failure("REVISION_CONFLICT", "Le document a changé depuis la dernière lecture");
        if (Token(target) != Json.Str(inputs, "expectedStateToken")) return Failure("STATE_CONFLICT", "Le document a changé depuis la dernière inspection");
        var slots = inputs["slots"]!.AsArray();
        var backups = new JsonArray();
        int index = 0;
        foreach (var document in Documents.OrderBy(entry => entry.Id))
        {
            Samples.WriteIndd(Native(slots[index]!.GetValue<string>()), $"{document.Id}:{document.Version}");
            backups.Add(new JsonObject { ["slot"] = index, ["documentId"] = document.Id, ["revision"] = document.Revision, ["stateToken"] = Token(document), ["method"] = "saveACopy" });
            index++;
        }
        string code = Json.Str(inputs, "code")!;
        JsonObject? scriptError = null;
        var revisions = new JsonArray();
        if (code.Contains("throw", StringComparison.Ordinal)) scriptError = new JsonObject { ["message"] = "boom", ["line"] = 1 };
        else if (!code.Contains("read-only", StringComparison.Ordinal))
        {
            target.Version++;
            target.Modified = true;
            target.Revision++;
            revisions.Add(new JsonObject { ["documentId"] = target.Id, ["revision"] = target.Revision, ["stateToken"] = Token(target) });
        }
        bool saved = false, closed = false;
        if (Json.IsTrue(inputs, "save") && scriptError is null && target.Path is not null)
        {
            target.Saved = true;
            target.Modified = false;
            Samples.WriteIndd(target.Path, "saved");
            saved = true;
        }
        Samples.WritePng(Native(Json.Str(inputs, "previewPath")));
        string? token = Token(target);
        if (Json.IsTrue(inputs, "close") && saved)
        {
            Documents.Remove(target);
            closed = true;
        }
        return new JsonObject
        {
            ["ok"] = true, ["scriptOk"] = scriptError is null, ["scriptError"] = scriptError, ["result"] = null, ["documentId"] = target.Id,
            ["revision"] = target.Revision, ["stateToken"] = closed ? null : token, ["revisions"] = revisions, ["saved"] = saved, ["closed"] = closed,
            ["backups"] = backups, ["preview"] = new JsonObject { ["pages"] = "1" },
        };
    }

    private JsonObject Restore(JsonObject inputs)
    {
        if (!ExpectedDocumentsMatch(inputs)) return Failure("DOCUMENT_STATE_CONFLICT", "Un document a changé après les sauvegardes");
        var current = Find(inputs)!;
        string path = Native(Json.Str(inputs, "restoredWorkingPath"));
        Documents.Remove(current);
        var restored = Add(System.IO.Path.GetFileName(path), path, current.Revision + 1);
        return new JsonObject
        {
            ["ok"] = true, ["restoredDocumentId"] = restored.Id, ["originalDocumentId"] = current.Id, ["revision"] = restored.Revision, ["stateToken"] = Token(restored),
        };
    }
}
