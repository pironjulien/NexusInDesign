using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Security;

/// <summary>
/// The private audit journal (JSON lines): tool, document, revision, outcome, error code, backups and a hash of the
/// reason. Never a document text, a full path, code or a secret; free-code tools never log their error codes.
/// </summary>
internal sealed partial class AuditLogger(string? filePath)
{
    private static readonly HashSet<string> FreeCodeTools = ["execute_uxp_silent", "run_layout_script"];
    private readonly object sync = new();

    [GeneratedRegex("^[A-Z][A-Z0-9_]{0,63}$")] private static partial Regex ErrorCode();
    [GeneratedRegex("^[a-f0-9-]{24,80}$", RegexOptions.IgnoreCase)] private static partial Regex BackupId();

    public string? FilePath => filePath;

    public sealed record Event(string Name, string ToolName, string Outcome)
    {
        public long? DocumentId { get; init; }
        public long? ExpectedRevision { get; init; }
        public string? Reason { get; init; }
        public string? ErrorCode { get; init; }
        public long DurationMs { get; init; }
        public IEnumerable<string?>? BackupIds { get; init; }
        public string? OperationId { get; init; }
        public bool RequiresInspection { get; init; }
    }

    public void Write(Event entry)
    {
        var backups = (entry.BackupIds ?? []).Where(id => id is not null && BackupId().IsMatch(id)).Distinct().Take(200).ToList();
        var line = new JsonObject
        {
            ["timestamp"] = DateTime.UtcNow.ToString("o"),
            ["event"] = entry.Name,
            ["toolName"] = entry.ToolName,
            ["documentId"] = entry.DocumentId,
            ["expectedRevision"] = entry.ExpectedRevision,
            ["outcome"] = entry.Outcome,
            ["durationMs"] = entry.DurationMs,
        };
        if (entry.Outcome is "error" or "validation_error" && !FreeCodeTools.Contains(entry.ToolName) && entry.ErrorCode is { } code && ErrorCode().IsMatch(code))
            line["errorCode"] = code;
        if (backups.Count > 0)
        {
            line["backupId"] = backups[0];
            line["backupIds"] = Json.Array(backups.Select(id => (JsonNode?)id));
        }
        if (entry.OperationId is { } operation && Json.Uuid().IsMatch(operation)) line["operationId"] = operation;
        if (entry.RequiresInspection) line["requiresInspection"] = true;
        if (!string.IsNullOrEmpty(entry.Reason)) line["reasonHash"] = Json.Sha256(entry.Reason);
        foreach (var key in line.Where(pair => pair.Value is null).Select(pair => pair.Key).ToList()) line.Remove(key);
        string text = line.ToJsonString(Json.Compact) + "\n";
        if (filePath is null)
        {
            Console.Error.Write("[audit] " + text);
            return;
        }
        lock (sync) File.AppendAllText(filePath, text);
    }
}
