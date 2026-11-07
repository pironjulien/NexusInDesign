using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using NexusInDesign.Security;
using NexusInDesign.Verification;

namespace NexusInDesign.InDesign;

/// <summary>
/// The silent channel: InDesign driven only through COM DoScript (UXP scripts under NEVER_INTERACT), never through a
/// panel or a network listener. Every mutation holds a durable lease (.mutation-lease.json) and the shared automation
/// mutex, backs up every open document first, checks revision and stateToken before and after, and keeps its script and
/// result file until its outcome is known; an unknown outcome blocks every InDesign command until
/// silent_reconcile_unknown_operation proves the documents stable, backs them up and releases the lease.
/// </summary>
internal sealed partial class SilentBridge
{
    private const int BackupMetadataVersion = 1;
    private const int FastBackupSlots = 16;
    private static readonly TimeSpan RuntimeRetention = TimeSpan.FromHours(24);
    private const long ReconciliationRecordLimit = 1024 * 1024;

    private readonly IInDesignHost host;
    private readonly AsyncLocal<string?> activeOperation = new();
    private readonly AsyncLocal<IAsyncDisposable?> activeHold = new();
    private readonly Dictionary<string, PendingOperation> pendingOperations = new(StringComparer.Ordinal);
    private bool reconciliationActive;

    public SilentBridge(IInDesignHost host, string backupDirectory, string runtimeRoot, TimeSpan timeout, long maxResultBytes)
    {
        if (!Path.IsPathFullyQualified(backupDirectory)) throw new ArgumentException("backupDirectory must be absolute.");
        if (!Path.IsPathFullyQualified(runtimeRoot)) throw new ArgumentException("runtimeRoot must be absolute.");
        this.host = host;
        BackupDirectory = backupDirectory;
        RuntimeRoot = runtimeRoot;
        LeasePath = Path.Combine(runtimeRoot, ".mutation-lease.json");
        SessionId = Json.NewId();
        RuntimeDirectory = Path.Combine(runtimeRoot, SessionId);
        Timeout = timeout;
        MaxResultBytes = maxResultBytes;
    }

    public string BackupDirectory { get; }
    public string RuntimeRoot { get; }
    public string LeasePath { get; }
    public string SessionId { get; }
    public string RuntimeDirectory { get; }
    public TimeSpan Timeout { get; }
    public long MaxResultBytes { get; }
    public IInDesignHost Host => host;

    private sealed record PendingOperation(string ResultPath, string ScriptPath, DateTime LaunchedAt);

    public void Initialize()
    {
        PrivateAcl.PrepareDirectory(RuntimeRoot);
        CleanupStaleRuntimeSessions();
        Directory.CreateDirectory(RuntimeDirectory);
        PrivateAcl.Protect(RuntimeDirectory, directory: true, recursive: true);
    }

    public void Close()
    {
        bool unresolved = pendingOperations.Count > 0;
        pendingOperations.Clear();
        try
        {
            if (!unresolved && Directory.Exists(RuntimeDirectory) && !Directory.EnumerateFileSystemEntries(RuntimeDirectory).Any())
                Directory.Delete(RuntimeDirectory, recursive: true);
        }
        catch (IOException) { }
    }

    // ----- Errors and small file helpers -----------------------------------------------------------------------------

    private static ToolError Fail(string code, string message, bool inspect = false, string? operationId = null) =>
        new(code, message, inspect) { OperationId = operationId };

    private static bool IsRegularFile(string path, out FileInfo info)
    {
        info = new FileInfo(path);
        return info.Exists && !info.Attributes.HasFlag(FileAttributes.ReparsePoint);
    }

    private static bool IsRegularDirectory(string path) =>
        Directory.Exists(path) && !new DirectoryInfo(path).Attributes.HasFlag(FileAttributes.ReparsePoint);

    private static void Protect(string path, bool directory = false) => PrivateAcl.Protect(path, directory, recursive: directory);

    private static void WriteAtomicPrivateJson(string targetPath, JsonNode value)
    {
        string staged = $"{targetPath}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(Encoding.UTF8.GetBytes(value.ToJsonString(Json.Compact)));
                stream.Flush(true);
            }
            Protect(staged);
            File.Move(staged, targetPath, overwrite: true);
            Protect(targetPath);
        }
        finally
        {
            try { File.Delete(staged); } catch (IOException) { }
        }
    }

    private static void WritePrivateNewFile(string path, string content)
    {
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            stream.Write(Encoding.UTF8.GetBytes(content));
            stream.Flush(true);
        }
        Protect(path);
    }

    private static void DeleteQuietly(string? path)
    {
        if (path is null) return;
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static JsonObject? ReadSmallJson(string path, long limit)
    {
        if (!IsRegularFile(path, out var info) || info.Length <= 0 || info.Length > limit) return null;
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
        catch (System.Text.Json.JsonException) { return null; }
    }

    // ----- Durable lease ---------------------------------------------------------------------------------------------

    internal JsonObject? ReadLease()
    {
        var info = new FileInfo(LeasePath);
        if (!info.Exists) return null;
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length > 16_384)
            throw Fail("MUTATION_LEASE_INVALID", Strings.T("The cross-process InDesign lock is invalid.", "Le verrou inter-processus InDesign est invalide."), true);
        JsonObject? lease;
        try { lease = JsonNode.Parse(File.ReadAllText(LeasePath)) as JsonObject; }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or IOException)
        {
            throw Fail("MUTATION_LEASE_INVALID", Strings.T("The cross-process InDesign lock is unreadable.", "Le verrou inter-processus InDesign est illisible."), true);
        }
        if (lease is null || !Json.Uuid().IsMatch(Json.Str(lease, "operationId") ?? "") || !Json.Uuid().IsMatch(Json.Str(lease, "sessionId") ?? "")
            || Json.Long(lease, "schemaVersion") != 1)
            throw Fail("MUTATION_LEASE_INVALID", Strings.T("The cross-process InDesign lock does not hold a valid operation and session.", "Le verrou inter-processus InDesign ne contient pas une opération et une session valides."), true);
        return lease;
    }

    private JsonObject AcquireLease(string operationId)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var lease = new JsonObject
            {
                ["schemaVersion"] = 1,
                ["operationId"] = operationId,
                ["sessionId"] = SessionId,
                ["kind"] = "silent",
                ["createdAt"] = DateTime.UtcNow.ToString("o"),
                ["processId"] = Environment.ProcessId,
                ["processStartedAt"] = Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("o"),
            };
            try
            {
                WritePrivateNewFile(LeasePath, lease.ToJsonString(Json.Compact));
                return lease;
            }
            catch (IOException) when (File.Exists(LeasePath))
            {
                var existing = ReadLease()!;
                string existingId = Json.Str(existing, "operationId")!;
                var retained = FindRetainedOperation(existingId);
                if (retained is not null)
                {
                    var state = ReadResult(retained.ResultPath);
                    if (!state.Pending && !Json.IsTrue(state.Result, "requiresInspection") && !LeaseOwnerAlive(existing))
                    {
                        ReleaseLease(existingId);
                        continue;
                    }
                }
                throw Fail("MUTATION_IN_PROGRESS", Strings.T("Another InDesign mutation is still running or its outcome must be reconciled.", "Une autre mutation InDesign est encore active ou son issue doit être réconciliée."), true, existingId);
            }
        }
        throw Fail("MUTATION_IN_PROGRESS", Strings.T("The cross-process InDesign lock could not be acquired.", "Le verrou inter-processus InDesign n’a pas pu être acquis."), true);
    }

    private bool ReleaseLease(string operationId)
    {
        JsonObject? existing;
        try { existing = ReadLease(); } catch (ToolError) { return false; }
        if (existing is null || Json.Str(existing, "operationId") != operationId) return false;
        File.Delete(LeasePath);
        return true;
    }

    private void UpdateLease(string operationId, Action<JsonObject> change)
    {
        var lease = ReadLease();
        if (lease is null || Json.Str(lease, "operationId") != operationId)
            throw Fail("MUTATION_LEASE_MISMATCH", Strings.T("The silent lock to complete is missing or changed.", "Le verrou silencieux à compléter est absent ou a changé."), true, operationId);
        change(lease);
        WriteAtomicPrivateJson(LeasePath, lease);
    }

    /// <summary>Is the server that wrote the lease still running (same process id and start time)?</summary>
    internal static bool LeaseOwnerAlive(JsonObject lease)
    {
        if (Json.Long(lease, "processId") is not long pid || pid <= 0) return false;
        if (!DateTime.TryParse(Json.Str(lease, "processStartedAt"), null, System.Globalization.DateTimeStyles.RoundtripKind, out var started)) return false;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return Math.Abs((process.StartTime.ToUniversalTime() - started.ToUniversalTime()).TotalSeconds) < 1;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    /// <summary>Run under the shared mutex, right before DoScript: a lease that is not this operation's blocks it.</summary>
    private void GuardAgainstForeignLease(string? operationId)
    {
        var lease = ReadLease();
        if (lease is null) return;
        if (operationId is not null && Json.Str(lease, "operationId") == operationId) return;
        throw Fail("MUTATION_IN_PROGRESS", Strings.T("An InDesign mutation is locked by a durable lease; check silent_operation_status, then reconcile it before any new command.", "Une mutation InDesign est verrouillée par un lease durable ; consultez silent_operation_status puis réconciliez-la avant toute nouvelle commande."),
            true, Json.Str(lease, "operationId"));
    }

    /// <summary>
    /// One mutation: durable lease, then the shared mutex for its whole duration. A known outcome (success or a failure
    /// that proves nothing changed) releases the lease; an unknown one keeps it for reconciliation.
    /// </summary>
    public async Task<JsonObject> WithMutationGuard(string operationId, Func<Task<JsonObject>> callback)
    {
        if (activeOperation.Value is { } active)
        {
            if (active != operationId)
                throw Fail("SILENT_LEASE_CONTEXT_MISMATCH", Strings.T("Another silent operation is already running in this context.", "Une autre opération silencieuse est déjà active dans ce contexte."), true, active);
            return await callback().ConfigureAwait(false);
        }
        AcquireLease(operationId);
        IAsyncDisposable? hold = null;
        try
        {
            hold = await host.HoldAsync(operationId).ConfigureAwait(false);
            activeOperation.Value = operationId;
            activeHold.Value = hold;
            var result = await callback().ConfigureAwait(false);
            ReleaseLease(operationId);
            if (pendingOperations.Remove(operationId, out var completed))
            {
                DeleteQuietly(completed.ResultPath);
                DeleteQuietly(completed.ScriptPath);
            }
            return result;
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            error.OperationId ??= operationId;
            if (!error.RequiresInspection)
            {
                ReleaseLease(operationId);
                if (pendingOperations.Remove(operationId, out var abandoned))
                {
                    DeleteQuietly(abandoned.ResultPath);
                    DeleteQuietly(abandoned.ScriptPath);
                }
            }
            throw error;
        }
        finally
        {
            activeOperation.Value = null;
            activeHold.Value = null;
            if (hold is not null) await hold.DisposeAsync().ConfigureAwait(false);
        }
    }

    // ----- Running scripts -------------------------------------------------------------------------------------------

    private static JsonObject ParseUxpResult(string? raw)
    {
        JsonObject? output;
        try { output = raw is null ? null : JsonNode.Parse(raw) as JsonObject; }
        catch (System.Text.Json.JsonException)
        {
            throw Fail("UXP_RESULT_INVALID", Strings.T("InDesign returned an unreadable UXP result.", "InDesign a renvoyé un résultat UXP illisible."));
        }
        if (output is null) throw Fail("UXP_RESULT_INVALID", Strings.T("InDesign returned no UXP result.", "InDesign n’a renvoyé aucun résultat UXP."));
        return CheckUxpResult(output);
    }

    private static JsonObject CheckUxpResult(JsonObject output)
    {
        if (Json.Bool(output, "ok") == false)
        {
            throw new ToolError(Json.Str(output, "code") ?? "UXP_ERROR", Json.Str(output, "message") ?? Strings.T("The InDesign run failed.", "L’exécution InDesign a échoué."),
                Json.IsTrue(output, "requiresInspection"))
            { OperationId = Json.Str(output, "operationId") };
        }
        return output;
    }

    private async Task<string?> RunScript(string template, ScriptLanguage language, string source, JsonObject inputs,
        string? scriptPath = null, bool retain = false, string? completionPath = null, TimeSpan? timeout = null)
    {
        string path = scriptPath ?? Path.Combine(RuntimeDirectory, $"{Guid.NewGuid():N}{(language == ScriptLanguage.Uxp ? ".idjs" : ".jsx")}");
        WritePrivateNewFile(path, source);
        try
        {
            string? operationId = activeOperation.Value;
            var run = new ScriptRun(template, language, path, completionPath, timeout ?? Timeout, inputs)
            {
                Guard = () => GuardAgainstForeignLease(operationId),
                Hold = activeHold.Value,
            };
            return await host.RunAsync(run).ConfigureAwait(false);
        }
        finally
        {
            if (!retain) DeleteQuietly(path);
        }
    }

    private async Task<JsonObject> RunUxpSync(string template, string body, JsonObject inputs, TimeSpan? timeout = null) =>
        ParseUxpResult(await RunScript(template, ScriptLanguage.Uxp, UxpTemplates.SyncScript(body), inputs, timeout: timeout).ConfigureAwait(false));

    private async Task<JsonObject> RunUxpRead(string template, string body, JsonObject inputs)
    {
        string operationId = Json.NewId();
        string resultPath = Path.Combine(RuntimeDirectory, $"{operationId}.result.json");
        string source = UxpTemplates.AsyncScript(body, resultPath, MaxResultBytes, operationId);
        try
        {
            await RunScript(template, ScriptLanguage.Uxp, source, inputs, completionPath: resultPath).ConfigureAwait(false);
            return CheckUxpResult(await WaitForResult(resultPath, operationId).ConfigureAwait(false));
        }
        catch (ToolError error) when (error.Code == "UXP_OUTCOME_UNKNOWN")
        {
            throw new ToolError("UXP_READ_OUTCOME_UNKNOWN", Strings.T("The asynchronous UXP read produced no verifiable result.", "La lecture UXP asynchrone n’a pas produit de résultat vérifiable."), error.RequiresInspection, error);
        }
        finally
        {
            DeleteQuietly(resultPath);
        }
    }

    /// <summary>The one tracked script of a mutation: kept with its result until the operation's outcome is known.</summary>
    private async Task<JsonObject> RunUxpTracked(string template, string body, JsonObject inputs, string operationId)
    {
        if (activeOperation.Value != operationId)
            return await WithMutationGuard(operationId, () => RunUxpTracked(template, body, inputs, operationId)).ConfigureAwait(false);
        if (pendingOperations.ContainsKey(operationId))
            throw Fail("OPERATION_ALREADY_DISPATCHED", Strings.T("This operation already sent its tracked script to InDesign.", "Cette opération a déjà envoyé son script suivi à InDesign."), true, operationId);
        string resultPath = Path.Combine(RuntimeDirectory, $"{operationId}.result.json");
        string scriptPath = Path.Combine(RuntimeDirectory, $"{operationId}.idjs");
        string source = UxpTemplates.AsyncScript(body, resultPath, MaxResultBytes, operationId);
        pendingOperations[operationId] = new PendingOperation(resultPath, scriptPath, DateTime.UtcNow);
        // InDesign processes alive at dispatch (and right after, should the call start one): reconciliation of an
        // unknown outcome later demands that none of them still runs, so the script can no longer resume.
        RecordDispatchHosts(operationId);
        try
        {
            await RunScript(template, ScriptLanguage.Uxp, source, inputs, scriptPath, retain: true, completionPath: resultPath).ConfigureAwait(false);
            RecordDispatchHosts(operationId);
            var result = await WaitForResult(resultPath, operationId).ConfigureAwait(false);
            Protect(resultPath);
            return CheckUxpResult(result);
        }
        catch (Exception exception)
        {
            var error = ToolError.From(exception);
            error.OperationId ??= operationId;
            if (error.RequiresInspection)
            {
                try { RecordDispatchHosts(operationId); } catch (ToolError) { }
            }
            else
            {
                pendingOperations.Remove(operationId);
                DeleteQuietly(resultPath);
                DeleteQuietly(scriptPath);
            }
            throw error;
        }
    }

    private void RecordDispatchHosts(string operationId)
    {
        var current = host.Processes();
        UpdateLease(operationId, lease =>
        {
            var known = (lease["hostProcessesAtDispatch"] as JsonArray)?.OfType<JsonObject>().ToList() ?? [];
            foreach (var process in current)
            {
                string startedAt = process.StartedAtUtc.ToString("o");
                if (!known.Any(entry => Json.Long(entry, "processId") == process.ProcessId && Json.Str(entry, "startedAt") == startedAt))
                    known.Add(new JsonObject { ["processId"] = process.ProcessId, ["startedAt"] = startedAt });
            }
            lease["hostProcessesAtDispatch"] = Json.Array(known);
        });
    }

    private sealed record ResultState(bool Pending, JsonObject? Result);

    private ResultState ReadResult(string resultPath)
    {
        var info = new FileInfo(resultPath);
        if (!info.Exists) return new ResultState(true, null);
        if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw Fail("UXP_RESULT_INVALID", Strings.T("The UXP result file is not a regular private file.", "Le fichier résultat UXP n’est pas un fichier privé normal."), true);
        Protect(resultPath);
        if (info.Length > MaxResultBytes) throw Fail("RESULT_TOO_LARGE_AFTER_MUTATION", Strings.T("The UXP result exceeds the maximum allowed size.", "Le résultat UXP dépasse la taille maximale autorisée."), true);
        try
        {
            return JsonNode.Parse(File.ReadAllText(resultPath)) is JsonObject result ? new ResultState(false, result) : new ResultState(true, null);
        }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or IOException)
        {
            return new ResultState(true, null);
        }
    }

    private async Task<JsonObject> WaitForResult(string resultPath, string operationId)
    {
        var deadline = DateTime.UtcNow + Timeout;
        while (DateTime.UtcNow < deadline)
        {
            var state = ReadResult(resultPath);
            if (!state.Pending) return state.Result!;
            await Task.Delay(25).ConfigureAwait(false);
        }
        throw Fail("UXP_OUTCOME_UNKNOWN", Strings.T("The UXP timeout expired; the outcome may be unknown. Inspect the document before any new action.", "Le délai UXP est dépassé ; l’issue peut être indéterminée. Inspectez le document avant toute nouvelle action."), true, operationId);
    }

    // ----- Retained evidence -----------------------------------------------------------------------------------------

    private sealed record RetainedOperation(string ResultPath, string ScriptPath, string QuarantinedScriptPath, DateTime LaunchedAt, DateTime RetainedUntil);

    private IEnumerable<DirectoryInfo> SessionDirectories()
    {
        if (!Directory.Exists(RuntimeRoot)) yield break;
        foreach (var directory in new DirectoryInfo(RuntimeRoot).EnumerateDirectories())
        {
            if (!Json.Uuid().IsMatch(directory.Name) || directory.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            yield return directory;
        }
    }

    private RetainedOperation? FindRetainedOperation(string operationId)
    {
        if (!Json.Uuid().IsMatch(operationId)) return null;
        foreach (var directory in SessionDirectories())
        {
            string result = Path.Combine(directory.FullName, $"{operationId}.result.json");
            string script = Path.Combine(directory.FullName, $"{operationId}.idjs");
            string quarantined = Path.Combine(directory.FullName, $"{operationId}.quarantined.idjs");
            if (IsRegularFile(result, out _) || IsRegularFile(script, out _) || IsRegularFile(quarantined, out _))
                return new RetainedOperation(result, script, quarantined, directory.CreationTimeUtc, directory.LastWriteTimeUtc + RuntimeRetention);
        }
        return null;
    }

    private void CleanupStaleRuntimeSessions()
    {
        string? leasedSession = null;
        try { leasedSession = Json.Str(ReadLease(), "sessionId"); } catch (ToolError) { }
        var cutoff = DateTime.UtcNow - RuntimeRetention;
        foreach (var directory in SessionDirectories().ToList())
        {
            if (directory.Name == leasedSession) continue;
            if (directory.LastWriteTimeUtc < cutoff)
            {
                try { directory.Delete(recursive: true); } catch (IOException) { }
            }
        }
    }

    private bool InDesignRestartedSince(string? isoDate)
    {
        if (!DateTime.TryParse(isoDate, null, System.Globalization.DateTimeStyles.RoundtripKind, out var since)) return false;
        var hosts = host.Processes();
        return hosts.Count > 0 && hosts.All(process => process.StartedAtUtc > since.ToUniversalTime());
    }

    /// <summary>No InDesign process alive at dispatch still runs, and one runs now: the script cannot resume.</summary>
    private void AssertInDesignHostRestarted(JsonObject lease, string operationId)
    {
        var original = (lease["hostProcessesAtDispatch"] as JsonArray)?.OfType<JsonObject>()
            .Where(entry => Json.Long(entry, "processId") > 0 && DateTime.TryParse(Json.Str(entry, "startedAt"), null, System.Globalization.DateTimeStyles.RoundtripKind, out _))
            .ToList() ?? [];
        var current = host.Processes();
        bool originalAlive = current.Any(process => original.Any(entry =>
            Json.Long(entry, "processId") == process.ProcessId
            && Math.Abs((DateTime.Parse(Json.Str(entry, "startedAt")!, null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime() - process.StartedAtUtc).TotalSeconds) < 1));
        bool restarted = original.Count > 0 || InDesignRestartedSince(Json.Str(lease, "createdAt"));
        if (!restarted || current.Count == 0 || originalAlive)
            throw Fail("RECONCILIATION_RESTART_REQUIRED", Strings.T("The UXP script may still resume: quit InDesign completely, start it again, then retry the reconciliation.", "Le script UXP peut encore reprendre : fermez complètement InDesign, relancez-le, puis recommencez la réconciliation."), true, operationId);
    }

    // ----- Operation status and reconciliation -----------------------------------------------------------------------

    private JsonObject? FindReconciliationRecord(string operationId)
    {
        if (!Json.Uuid().IsMatch(operationId)) return null;
        var records = new List<JsonObject>();
        foreach (var directory in SessionDirectories())
        {
            foreach (var file in directory.EnumerateFiles($"{operationId}.*.reconciliation.json"))
            {
                string receipt = file.Name[(operationId.Length + 1)..^".reconciliation.json".Length];
                if (!Json.Uuid().IsMatch(receipt)) continue;
                if (file.Attributes.HasFlag(FileAttributes.ReparsePoint) || file.Length <= 0 || file.Length > ReconciliationRecordLimit)
                    throw Fail("RECONCILIATION_EVIDENCE_INVALID", Strings.T("The private reconciliation evidence is invalid.", "La preuve privée de réconciliation est invalide."), true, operationId);
                Protect(file.FullName);
                var record = ReadSmallJson(file.FullName, ReconciliationRecordLimit)
                    ?? throw Fail("RECONCILIATION_EVIDENCE_INVALID", Strings.T("The private reconciliation evidence is unreadable.", "La preuve privée de réconciliation est illisible."), true, operationId);
                string? releaseState = Json.Str(record, "releaseState");
                bool validRelease = releaseState is null or "prepared" || (releaseState == "confirmed" && DateTime.TryParse(Json.Str(record, "releaseConfirmedAt"), out _));
                if (Json.Long(record, "schemaVersion") != 1 || Json.Str(record, "operationId") != operationId
                    || Json.Str(record, "status") is not ("reconciled-unknown" or "completed-during-reconciliation")
                    || !DateTime.TryParse(Json.Str(record, "reconciledAt"), out _)
                    || !Json.Sha256Hex().IsMatch(Json.Str(record, "reasonSha256") ?? "")
                    || record["snapshots"] is not JsonArray || record["backupIds"] is not JsonArray backupIds
                    || !backupIds.All(id => id is JsonValue value && value.TryGetValue(out string? text) && Json.BackupId().IsMatch(text))
                    || !validRelease)
                    throw Fail("RECONCILIATION_EVIDENCE_INVALID", Strings.T("The private reconciliation evidence does not match the operation.", "La preuve privée de réconciliation ne correspond pas à l’opération."), true, operationId);
                record["recordPath"] = file.FullName;
                record["retainedUntil"] = (file.LastWriteTimeUtc + RuntimeRetention).ToString("o");
                records.Add(record);
            }
        }
        return records.OrderBy(record => DateTime.Parse(Json.Str(record, "reconciledAt")!, null, System.Globalization.DateTimeStyles.RoundtripKind)).LastOrDefault();
    }

    /// <summary>A prepared receipt becomes confirmed once the lease is provably gone.</summary>
    private JsonObject PromotePreparedReconciliation(JsonObject record)
    {
        if (Json.Str(record, "releaseState") != "prepared") return record;
        if (Json.Str(ReadLease(), "operationId") == Json.Str(record, "operationId")) return record;
        var confirmed = (JsonObject)record.DeepClone();
        confirmed["releaseState"] = "confirmed";
        confirmed["releaseConfirmedAt"] = DateTime.UtcNow.ToString("o");
        var persisted = (JsonObject)confirmed.DeepClone();
        string path = Json.Str(persisted, "recordPath")!;
        persisted.Remove("recordPath");
        persisted.Remove("retainedUntil");
        WriteAtomicPrivateJson(path, persisted);
        return confirmed;
    }

    public Task<JsonObject> OperationStatus(string operationId)
    {
        var retained = pendingOperations.TryGetValue(operationId, out var pending)
            ? new RetainedOperation(pending.ResultPath, pending.ScriptPath, "", pending.LaunchedAt, pending.LaunchedAt + RuntimeRetention)
            : FindRetainedOperation(operationId);
        var reconciliation = FindReconciliationRecord(operationId);
        if (reconciliation is not null && Json.Str(reconciliation, "releaseState") == "prepared")
            reconciliation = PromotePreparedReconciliation(reconciliation);
        if (reconciliation is not null && Json.Str(reconciliation, "releaseState") != "prepared")
        {
            var state = retained is null ? new ResultState(true, null) : ReadResult(retained.ResultPath);
            var confirmedStatus = new JsonObject
            {
                ["ok"] = true,
                ["operationId"] = operationId,
                ["status"] = Json.Str(reconciliation, "status"),
            };
            if (!state.Pending) confirmedStatus["outcome"] = state.Result!.DeepClone();
            confirmedStatus["reconciledAt"] = Json.Str(reconciliation, "reconciledAt");
            Json.SetIfNotNull(confirmedStatus, "releaseConfirmedAt", Json.Str(reconciliation, "releaseConfirmedAt"));
            confirmedStatus["backupIds"] = reconciliation["backupIds"]!.DeepClone();
            confirmedStatus["retainedUntil"] = Json.Str(reconciliation, "retainedUntil");
            confirmedStatus["requiresInspection"] = Json.Bool(reconciliation, "requiresInspection") ?? true;
            confirmedStatus["requiresReconciliation"] = false;
            return Task.FromResult(confirmedStatus);
        }
        if (reconciliation is not null)
        {
            return Task.FromResult(new JsonObject
            {
                ["ok"] = true, ["operationId"] = operationId, ["status"] = "reconciliation-release-pending",
                ["reconciledAt"] = Json.Str(reconciliation, "reconciledAt"), ["retainedUntil"] = Json.Str(reconciliation, "retainedUntil"),
                ["requiresInspection"] = true, ["requiresReconciliation"] = true,
            });
        }
        if (retained is null)
        {
            var lease = ReadLease();
            if (Json.Str(lease, "operationId") == operationId)
                return Task.FromResult(new JsonObject
                {
                    ["ok"] = true, ["operationId"] = operationId, ["status"] = "pending", ["leaseKind"] = "silent",
                    ["requiresInspection"] = true, ["requiresReconciliation"] = true,
                });
            return Task.FromResult(new JsonObject
            {
                ["ok"] = true, ["operationId"] = operationId, ["status"] = "not-found", ["requiresInspection"] = true, ["requiresReconciliation"] = false,
            });
        }
        var result = ReadResult(retained.ResultPath);
        if (result.Pending)
            return Task.FromResult(new JsonObject
            {
                ["ok"] = true, ["operationId"] = operationId, ["status"] = "pending", ["launchedAt"] = retained.LaunchedAt.ToString("o"),
                ["requiresInspection"] = true, ["requiresReconciliation"] = true,
            });
        if (Json.IsTrue(result.Result, "requiresInspection"))
            return Task.FromResult(new JsonObject
            {
                ["ok"] = true, ["operationId"] = operationId, ["status"] = "completed-requires-reconciliation", ["outcome"] = result.Result!.DeepClone(),
                ["retainedUntil"] = retained.RetainedUntil.ToString("o"), ["requiresInspection"] = true, ["requiresReconciliation"] = true,
            });
        var owner = ReadLease();
        if (owner is not null && Json.Str(owner, "operationId") == operationId && (Json.Str(owner, "sessionId") == SessionId || !LeaseOwnerAlive(owner)))
            ReleaseLease(operationId);
        return Task.FromResult(new JsonObject
        {
            ["ok"] = true, ["operationId"] = operationId, ["status"] = "completed", ["outcome"] = result.Result!.DeepClone(),
            ["retainedUntil"] = retained.RetainedUntil.ToString("o"), ["requiresInspection"] = false, ["requiresReconciliation"] = false,
        });
    }

    private string ClaimReconciliation(string operationId)
    {
        if (!Json.Uuid().IsMatch(operationId)) throw Fail("OPERATION_ID_INVALID", Strings.T("Invalid silent operation id.", "Identifiant d’opération silencieuse invalide."));
        string claimPath = Path.Combine(RuntimeRoot, $"{operationId}.reconciliation.claim.json");
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                WritePrivateNewFile(claimPath, new JsonObject
                {
                    ["schemaVersion"] = 1, ["operationId"] = operationId, ["sessionId"] = SessionId,
                    ["processId"] = Environment.ProcessId,
                    ["processStartedAt"] = Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("o"),
                    ["claimedAt"] = DateTime.UtcNow.ToString("o"),
                }.ToJsonString(Json.Compact));
                return claimPath;
            }
            catch (IOException) when (File.Exists(claimPath))
            {
                var claim = ReadSmallJson(claimPath, 4096);
                if (claim is null || Json.Long(claim, "schemaVersion") != 1 || Json.Str(claim, "operationId") != operationId)
                    throw Fail("RECONCILIATION_CLAIM_INVALID", Strings.T("The cross-process reconciliation claim is unreadable.", "La réservation inter-processus de réconciliation est illisible."), true, operationId);
                if (LeaseOwnerAlive(claim))
                    throw Fail("RECONCILIATION_ALREADY_ACTIVE_CROSS_PROCESS", Strings.T("Another task is already reconciling this InDesign operation.", "Une autre tâche réconcilie déjà cette opération InDesign."), true, operationId);
                DeleteQuietly(claimPath);
            }
        }
        throw Fail("RECONCILIATION_ALREADY_ACTIVE_CROSS_PROCESS", Strings.T("The cross-process reconciliation claim could not be acquired.", "La réservation inter-processus de réconciliation n’a pas pu être acquise."), true, operationId);
    }

    public async Task<JsonObject> ReconcileUnknownOperation(string operationId, string reason)
    {
        if (reconciliationActive) throw Fail("RECONCILIATION_ALREADY_ACTIVE", Strings.T("An InDesign reconciliation is already running.", "Une réconciliation InDesign est déjà active."), true);
        string claimPath = ClaimReconciliation(operationId);
        reconciliationActive = true;
        try
        {
            return await Reconcile(operationId, reason).ConfigureAwait(false);
        }
        finally
        {
            reconciliationActive = false;
            DeleteQuietly(claimPath);
        }
    }

    private async Task<JsonObject> Reconcile(string operationId, string reason)
    {
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 8 || reason.Length > 500)
            throw Fail("RECONCILIATION_REASON_REQUIRED", Strings.T("An explicit reconciliation reason is required.", "Un motif de réconciliation explicite est requis."));

        var prepared = FindReconciliationRecord(operationId);
        if (prepared is not null && Json.Str(prepared, "releaseState") == "prepared")
        {
            prepared = PromotePreparedReconciliation(prepared);
            if (Json.Str(prepared, "releaseState") == "confirmed")
            {
                var retainedOperation = FindRetainedOperation(operationId);
                var retainedState = retainedOperation is null ? new ResultState(true, null) : ReadResult(retainedOperation.ResultPath);
                var done = new JsonObject { ["ok"] = true, ["operationId"] = operationId, ["status"] = Json.Str(prepared, "status") };
                if (!retainedState.Pending) done["outcome"] = retainedState.Result!.DeepClone();
                done["snapshots"] = prepared["snapshots"]!.DeepClone();
                done["safetyBackups"] = new JsonArray();
                done["backupIds"] = prepared["backupIds"]!.DeepClone();
                done["reconciledAt"] = Json.Str(prepared, "reconciledAt");
                done["releaseConfirmedAt"] = Json.Str(prepared, "releaseConfirmedAt");
                done["requiresInspection"] = Json.Bool(prepared, "requiresInspection") ?? true;
                done["requiresReconciliation"] = false;
                return done;
            }
        }

        var lease = ReadLease();
        if (lease is null || Json.Str(lease, "operationId") != operationId)
            throw Fail("RECONCILIATION_LEASE_MISMATCH", Strings.T("The lock to reconcile is missing or changed.", "Le verrou à réconcilier est absent ou a changé."), true, operationId);
        if (Json.Str(lease, "sessionId") != SessionId && LeaseOwnerAlive(lease))
            throw Fail("RECONCILIATION_NOT_CRASHED", Strings.T("The server that set this lock is still running; only an interrupted operation can be reconciled.", "Le serveur qui a posé ce verrou fonctionne encore ; seule une opération interrompue peut être réconciliée."), true, operationId);
        if (activeOperation.Value is not null)
            throw Fail("RECONCILIATION_HOST_BUSY", Strings.T("An InDesign operation is still running in this server.", "Une opération InDesign est encore active dans ce serveur."), true, operationId);

        var retained = FindRetainedOperation(operationId);
        // Without evidence (session cut between the lease and the script), only a full InDesign restart after the
        // lease proves that no script of the operation can still run.
        if (retained is null && !InDesignRestartedSince(Json.Str(lease, "createdAt")))
            throw Fail("RECONCILIATION_EVIDENCE_MISSING", Strings.T("The private evidence of the interrupted operation is missing. Quit InDesign completely and start it again before reconciling.", "Les preuves privées de l’opération interrompue sont introuvables. Fermez complètement puis relancez InDesign avant de réconcilier."), true, operationId);
        var initial = retained is null ? new ResultState(true, null) : ReadResult(retained.ResultPath);
        if (!initial.Pending && !Json.IsTrue(initial.Result, "requiresInspection"))
        {
            if (!ReleaseLease(operationId))
                throw Fail("RECONCILIATION_RELEASE_FAILED", Strings.T("The lock could not be released after the result was confirmed.", "Le verrou n’a pas pu être libéré après la confirmation du résultat."), true, operationId);
            return new JsonObject
            {
                ["ok"] = true, ["operationId"] = operationId, ["status"] = "completed", ["outcome"] = initial.Result!.DeepClone(),
                ["safetyBackups"] = new JsonArray(), ["snapshots"] = new JsonArray(), ["requiresInspection"] = false, ["requiresReconciliation"] = false,
            };
        }
        if (initial.Pending) AssertInDesignHostRestarted(lease, operationId);

        await using var hold = await host.HoldAsync(operationId).ConfigureAwait(false);
        activeOperation.Value = operationId;
        activeHold.Value = hold;
        try
        {
            if (Json.IsTrue(await Status(refreshMarkers: false).ConfigureAwait(false), "modalState"))
                throw Fail("RECONCILIATION_HOST_BUSY", Strings.T("InDesign is still modal; the reconciliation stays blocked.", "InDesign est encore modal ; la réconciliation reste bloquée."), true, operationId);
            var first = await SnapshotAllDocuments().ConfigureAwait(false);
            await Task.Delay(500).ConfigureAwait(false);
            var second = await SnapshotAllDocuments().ConfigureAwait(false);
            AssertStableSnapshots(first, second, Strings.T("The documents are not stable during the reconciliation.", "Les documents ne sont pas stables pendant la réconciliation."));
            var safetyBackups = await BackupDocuments(second).ConfigureAwait(false);
            try
            {
                var final = await SnapshotAllDocuments().ConfigureAwait(false);
                AssertStableSnapshots(second, final, Strings.T("The documents changed after the reconciliation backups.", "Les documents ont changé après les sauvegardes de réconciliation."));
                if (Json.IsTrue(await Status(refreshMarkers: false).ConfigureAwait(false), "modalState"))
                    throw Fail("RECONCILIATION_HOST_BUSY", Strings.T("InDesign became modal again during the reconciliation.", "InDesign est redevenu modal pendant la réconciliation."), true, operationId);
                var current = ReadLease();
                if (current is null || Json.Str(current, "operationId") != operationId || Json.Str(current, "sessionId") != Json.Str(lease, "sessionId"))
                    throw Fail("RECONCILIATION_LEASE_MISMATCH", Strings.T("The lock changed during the reconciliation.", "Le verrou a changé pendant la réconciliation."), true, operationId);

                var finalResult = retained is null ? new ResultState(true, null) : ReadResult(retained.ResultPath);
                string? quarantined = null;
                if (finalResult.Pending && retained is not null)
                {
                    if (IsRegularFile(retained.ScriptPath, out _))
                    {
                        if (IsRegularFile(retained.QuarantinedScriptPath, out _)) File.Delete(retained.ScriptPath);
                        else File.Move(retained.ScriptPath, retained.QuarantinedScriptPath);
                        Protect(retained.QuarantinedScriptPath);
                    }
                    else if (!IsRegularFile(retained.QuarantinedScriptPath, out _))
                        throw Fail("RECONCILIATION_EVIDENCE_MISSING", Strings.T("The interrupted private script cannot be neutralized.", "Le script privé interrompu ne peut pas être neutralisé."), true, operationId);
                    quarantined = retained.QuarantinedScriptPath;
                }
                await Task.Delay(500).ConfigureAwait(false);
                if (Json.IsTrue(await Status(refreshMarkers: false).ConfigureAwait(false), "modalState"))
                    throw Fail("RECONCILIATION_HOST_BUSY", Strings.T("InDesign became modal again after the operation was neutralized.", "InDesign est redevenu modal après la neutralisation de l’opération."), true, operationId);
                var settled = await SnapshotAllDocuments().ConfigureAwait(false);
                AssertStableSnapshots(final, settled, Strings.T("The documents changed after the operation was neutralized.", "Les documents ont changé après la neutralisation de l’opération."));
                finalResult = retained is null ? new ResultState(true, null) : ReadResult(retained.ResultPath);

                string reconciledAt = DateTime.UtcNow.ToString("o");
                string directory = retained is null ? RuntimeDirectory : Path.GetDirectoryName(retained.ResultPath)!;
                string recordPath = Path.Combine(directory, $"{operationId}.{Json.NewId()}.reconciliation.json");
                bool requiresInspection = finalResult.Pending || Json.IsTrue(finalResult.Result, "requiresInspection");
                var record = new JsonObject
                {
                    ["schemaVersion"] = 1,
                    ["operationId"] = operationId,
                    ["leaseKind"] = "silent",
                    ["reconciledAt"] = reconciledAt,
                    ["status"] = finalResult.Pending ? "reconciled-unknown" : "completed-during-reconciliation",
                    ["releaseState"] = "prepared",
                    ["requiresInspection"] = requiresInspection,
                    ["reasonSha256"] = Json.Sha256(reason.Trim()),
                    ["snapshots"] = settled.DeepClone(),
                    ["backupIds"] = Json.Array(safetyBackups.OfType<JsonObject>().Select(backup => backup["backupId"])),
                    ["quarantinedScript"] = quarantined is null ? null : Path.GetFileName(quarantined),
                };
                WriteAtomicPrivateJson(recordPath, record);
                if (!ReleaseLease(operationId))
                    throw Fail("RECONCILIATION_RELEASE_FAILED", Strings.T("The lock could not be released after reconciliation.", "Le verrou n’a pas pu être libéré après réconciliation."), true, operationId);
                string releaseConfirmedAt = DateTime.UtcNow.ToString("o");
                record["releaseState"] = "confirmed";
                record["releaseConfirmedAt"] = releaseConfirmedAt;
                WriteAtomicPrivateJson(recordPath, record);
                pendingOperations.Remove(operationId);
                var output = new JsonObject { ["ok"] = true, ["operationId"] = operationId, ["status"] = Json.Str(record, "status") };
                if (!finalResult.Pending) output["outcome"] = finalResult.Result!.DeepClone();
                output["snapshots"] = settled.DeepClone();
                output["safetyBackups"] = safetyBackups.DeepClone();
                output["reconciledAt"] = reconciledAt;
                output["releaseConfirmedAt"] = releaseConfirmedAt;
                output["requiresInspection"] = requiresInspection;
                output["requiresReconciliation"] = false;
                return output;
            }
            catch (ToolError error)
            {
                error.SafetyBackups ??= safetyBackups;
                error.RequiresInspection = true;
                throw;
            }
        }
        finally
        {
            activeOperation.Value = null;
            activeHold.Value = null;
        }
    }
}
