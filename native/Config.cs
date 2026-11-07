using System.Text.Json.Nodes;
using NexusInDesign.Security;

namespace NexusInDesign;

/// <summary>
/// Settings, from the environment (INDESIGN_MCP_*), then %USERPROFILE%\.nexus\nexus-indesign\settings.json, then the
/// defaults: private storage in ~\.nexus\nexus-indesign\private (never in OneDrive), the user's profile as read and
/// write root, secrets and private storage denied, Claude and Codex as the only allowed parents.
/// </summary>
internal sealed record Config
{
    public required string InstallRoot { get; init; }
    public required string PrivateRoot { get; init; }
    public required string BackupRoot { get; init; }
    public required string AuditFile { get; init; }
    public required string RuntimeRoot { get; init; }
    public required IReadOnlyList<string> ReadRoots { get; init; }
    public required IReadOnlyList<string> WriteRoots { get; init; }
    public required IReadOnlyList<string> DeniedRoots { get; init; }
    public required IReadOnlyList<AllowedParent> AllowedParents { get; init; }
    public required IReadOnlyList<string> AllowedParentPaths { get; init; }
    public TimeSpan CommandTimeout { get; init; } = TimeSpan.FromMinutes(2);
    public int MaxQueueLength { get; init; } = 100;
    public long MaxPayloadBytes { get; init; } = 4_194_304;
    public TimeSpan BackupMaxAge { get; init; } = TimeSpan.FromHours(24);
    public int BackupMaxFiles { get; init; } = 200;

    public static Config Load(IReadOnlyDictionary<string, string?>? environment = null)
    {
        string? Env(string name) => environment is null ? Environment.GetEnvironmentVariable(name)
            : environment.TryGetValue(name, out var value) ? value : null;
        string profile = Env("USERPROFILE") is { Length: > 0 } home ? home : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string installRoot = Absolute(Env("NEXUS_INDESIGN_HOME") ?? Path.Combine(profile, ".nexus", "nexus-indesign"), "NEXUS_INDESIGN_HOME");
        JsonObject settings = ReadSettings(Path.Combine(installRoot, "settings.json"));

        string privateRoot = Absolute(Env("INDESIGN_MCP_PRIVATE_ROOT") ?? Path.Combine(installRoot, "private"), "INDESIGN_MCP_PRIVATE_ROOT");
        string? oneDrive = Env("OneDrive");
        if (oneDrive is { Length: > 0 } && Path.IsPathFullyQualified(oneDrive) && PathPolicy.IsInside(Path.GetFullPath(oneDrive), privateRoot))
            throw new ToolError("CONFIG_INVALID", Strings.T("The InDesign private storage must stay outside OneDrive (INDESIGN_MCP_PRIVATE_ROOT).", "Le stockage privé InDesign doit rester hors OneDrive (INDESIGN_MCP_PRIVATE_ROOT)."));
        string backupRoot = Absolute(Env("INDESIGN_MCP_BACKUP_ROOT") ?? Path.Combine(privateRoot, "backups"), "INDESIGN_MCP_BACKUP_ROOT");
        if (!PathPolicy.IsInside(privateRoot, backupRoot)) throw new ToolError("CONFIG_INVALID", Strings.T("INDESIGN_MCP_BACKUP_ROOT must stay inside the private storage.", "INDESIGN_MCP_BACKUP_ROOT doit rester dans le stockage privé."));
        string auditFile = Absolute(Env("INDESIGN_MCP_AUDIT_FILE") ?? Path.Combine(privateRoot, "audit", "events.jsonl"), "INDESIGN_MCP_AUDIT_FILE");
        if (!PathPolicy.IsInside(privateRoot, auditFile)) throw new ToolError("CONFIG_INVALID", Strings.T("INDESIGN_MCP_AUDIT_FILE must stay inside the private storage.", "INDESIGN_MCP_AUDIT_FILE doit rester dans le stockage privé."));
        if (Path.GetExtension(auditFile).ToLowerInvariant() is not (".jsonl" or ".log"))
            throw new ToolError("CONFIG_INVALID", Strings.T("The internal journal must be a .jsonl or .log file.", "Le journal interne doit être un fichier .jsonl ou .log."));

        var readRoots = Roots(Env("INDESIGN_MCP_READ_ROOTS"), settings["readRoots"]) ?? [profile];
        var writeRoots = Roots(Env("INDESIGN_MCP_WRITE_ROOTS"), settings["writeRoots"]) ?? [profile];
        var denied = new List<string> { installRoot, privateRoot, Path.Combine(profile, ".nexus"), Path.Combine(profile, ".ssh"), Path.Combine(profile, ".gnupg") };
        foreach (string folder in new[] { Env("APPDATA"), Env("LOCALAPPDATA") }.OfType<string>().Where(Path.IsPathFullyQualified)) denied.Add(folder);
        denied.AddRange(Roots(Env("INDESIGN_MCP_DENIED_ROOTS"), settings["deniedRoots"]) ?? []);

        var names = List(Env("INDESIGN_MCP_ALLOWED_PARENT_NAMES"));
        var signers = List(Env("INDESIGN_MCP_ALLOWED_PARENT_SIGNERS"));
        IReadOnlyList<AllowedParent> parents = names is null
            ? [new AllowedParent("claude.exe", "Anthropic, PBC"), new AllowedParent("codex.exe", "OpenAI")]
            : names.SelectMany(name => (signers ?? ["Anthropic, PBC", "OpenAI"]).Select(signer => new AllowedParent(name, signer))).ToList();
        string programFiles = Env("ProgramFiles") ?? @"C:\Program Files";
        string localAppData = Env("LOCALAPPDATA") ?? Path.Combine(profile, "AppData", "Local");
        var parentPaths = Roots(Env("INDESIGN_MCP_ALLOWED_PARENT_PATHS"), null) ??
        [
            Path.Combine(programFiles, "WindowsApps"),
            Path.Combine(localAppData, "AnthropicClaude"),
            Path.Combine(localAppData, "Programs"),
            Path.Combine(localAppData, "OpenAI", "Codex", "bin"),
            Path.Combine(profile, ".local", "bin"),
        ];

        if (Env("INDESIGN_MCP_TOOL_PROFILE") is { Length: > 0 } toolProfile && toolProfile != "core")
            throw new ToolError("CONFIG_INVALID", Strings.T("Only the core profile exists: the legacy UXP plugin commands were removed in 4.0.0.", "Seul le profil core existe : les commandes historiques du plugin UXP ont été retirées en 4.0.0."));

        return new Config
        {
            InstallRoot = installRoot,
            PrivateRoot = privateRoot,
            BackupRoot = backupRoot,
            AuditFile = auditFile,
            RuntimeRoot = Path.Combine(privateRoot, "runtime", "silent-runtime"),
            ReadRoots = readRoots,
            WriteRoots = writeRoots,
            DeniedRoots = denied.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
            AllowedParents = parents,
            AllowedParentPaths = parentPaths,
            CommandTimeout = TimeSpan.FromMilliseconds(Integer(Env("INDESIGN_MCP_COMMAND_TIMEOUT_MS"), 120_000, "INDESIGN_MCP_COMMAND_TIMEOUT_MS", 1_000, 600_000)),
            MaxQueueLength = (int)Integer(Env("INDESIGN_MCP_MAX_QUEUE"), 100, "INDESIGN_MCP_MAX_QUEUE", 1, 1_000),
            MaxPayloadBytes = Integer(Env("INDESIGN_MCP_MAX_PAYLOAD_BYTES"), 4_194_304, "INDESIGN_MCP_MAX_PAYLOAD_BYTES", 65_536, 4_194_304),
            BackupMaxAge = TimeSpan.FromHours(Integer(Env("INDESIGN_MCP_BACKUP_MAX_AGE_HOURS"), 24, "INDESIGN_MCP_BACKUP_MAX_AGE_HOURS", 1, 720)),
            BackupMaxFiles = (int)Integer(Env("INDESIGN_MCP_BACKUP_MAX_FILES"), 200, "INDESIGN_MCP_BACKUP_MAX_FILES", 1, 10_000),
        };
    }

    private static string Absolute(string value, string name)
    {
        if (!Path.IsPathFullyQualified(value)) throw new ToolError("CONFIG_INVALID", Strings.T($"{name} must be an absolute path.", $"{name} doit désigner un chemin absolu."));
        return Path.GetFullPath(value);
    }

    private static long Integer(string? value, long fallback, string name, long min, long max)
    {
        if (string.IsNullOrEmpty(value)) return fallback;
        if (!long.TryParse(value, out long parsed) || parsed < min || parsed > max)
            throw new ToolError("CONFIG_INVALID", Strings.T($"{name} must be an integer between {min} and {max}.", $"{name} doit être un entier entre {min} et {max}."));
        return parsed;
    }

    private static List<string>? List(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private static List<string>? Roots(string? environment, JsonNode? setting)
    {
        IEnumerable<string>? items = !string.IsNullOrWhiteSpace(environment)
            ? environment.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : setting is JsonArray array ? array.Select(item => item?.GetValue<string>() ?? "") : null;
        if (items is null) return null;
        var list = items.Select(item => Environment.ExpandEnvironmentVariables(item)).Where(item => item.Length > 0).ToList();
        if (list.Count == 0 || list.Any(item => !Path.IsPathFullyQualified(item)))
            throw new ToolError("CONFIG_INVALID", Strings.T("The configured roots must be absolute paths.", "Les racines configurées doivent être des chemins absolus."));
        return list.Select(Path.GetFullPath).ToList();
    }

    private static JsonObject ReadSettings(string path)
    {
        if (!File.Exists(path)) return [];
        try
        {
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new System.Text.Json.JsonException();
        }
        catch (Exception exception) when (exception is System.Text.Json.JsonException or InvalidOperationException)
        {
            throw new ToolError("CONFIG_INVALID", Strings.T($"settings.json is unreadable: {exception.Message}", $"settings.json est illisible : {exception.Message}"));
        }
    }
}
