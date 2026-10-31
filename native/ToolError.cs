using System.Text.Json.Nodes;

namespace NexusInDesign;

/// <summary>
/// A refused or failed InDesign operation. Code is a stable UPPER_SNAKE identifier; the recovery fields tell the agent
/// what was saved (backups) and whether the outcome is unknown (RequiresInspection) before it acts again.
/// </summary>
public sealed class ToolError : Exception
{
    public ToolError(string code, string message, bool requiresInspection = false, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
        RequiresInspection = requiresInspection;
    }

    public string Code { get; set; }
    public bool RequiresInspection { get; set; }
    public string? OperationId { get; set; }
    public string? BackupId { get; set; }
    public string? BackupPath { get; set; }
    public JsonArray? SafetyBackups { get; set; }
    public string? TargetBackupId { get; set; }
    public string? TargetBackupPath { get; set; }
    public string? PartialOutputPath { get; set; }
    public JsonArray? DocumentStates { get; set; }

    public bool HasRecovery => BackupId is not null || SafetyBackups is not null || OperationId is not null
        || TargetBackupId is not null || PartialOutputPath is not null || DocumentStates is not null;

    public JsonObject Recovery()
    {
        var recovery = new JsonObject { ["requiresInspection"] = RequiresInspection };
        Json.SetIfNotNull(recovery, "backupId", BackupId);
        Json.SetIfNotNull(recovery, "backupPath", BackupPath);
        if (SafetyBackups is not null) recovery["safetyBackups"] = SafetyBackups.DeepClone();
        Json.SetIfNotNull(recovery, "operationId", OperationId);
        if (DocumentStates is not null) recovery["documentStates"] = DocumentStates.DeepClone();
        Json.SetIfNotNull(recovery, "targetBackupId", TargetBackupId);
        Json.SetIfNotNull(recovery, "targetBackupPath", TargetBackupPath);
        Json.SetIfNotNull(recovery, "partialOutputPath", PartialOutputPath);
        return recovery;
    }

    /// <summary>Fills the backup fields from the target document's safety backup when they are still empty.</summary>
    public ToolError WithBackups(JsonArray? safetyBackups, long documentId)
    {
        SafetyBackups ??= safetyBackups;
        var target = SafetyBackups?.OfType<JsonObject>().FirstOrDefault(backup => Json.Long(backup, "documentId") == documentId);
        BackupId ??= Json.Str(target, "backupId");
        BackupPath ??= Json.Str(target, "backupPath");
        return this;
    }

    public static ToolError From(Exception exception, string fallbackCode = "INTERNAL_ERROR") => exception switch
    {
        ToolError error => error,
        UnauthorizedAccessException => new ToolError("ACCESS_DENIED", exception.Message, inner: exception),
        FileNotFoundException or DirectoryNotFoundException => new ToolError("PATH_NOT_FOUND", exception.Message, inner: exception),
        IOException => new ToolError("IO_ERROR", exception.Message, inner: exception),
        _ => new ToolError(fallbackCode, exception.Message, inner: exception),
    };
}
