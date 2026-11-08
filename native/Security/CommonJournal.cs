using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace NexusInDesign.Security;

/// <summary>
/// Common journal of the Nexus tools (NexusShared/journal/FORMAT.md, v1), product "indesign": one short line per tool
/// call in %USERPROFILE%\.nexus\journal\indesign\&lt;agent&gt;\&lt;YYYY-MM&gt;.jsonl, IN ADDITION to the private audit
/// journal. `app` is always indesign.exe, `action` the tool name, `technique` its route, `erreur` the stable error code
/// (PATH_DENIED, UXP_ERROR…), never a message, a path, a document name or a text. Never under AppData (an MSIX AI app
/// redirects those writes into its private copy). Never blocks nor throws: a failed write loses the line.
/// </summary>
internal sealed class CommonJournal(string root, string? agent = null)
{
    private static readonly object Gate = new();

    /// <summary>The AI using the server (claude, codex, antigravity), from the verified parent or the MCP client.</summary>
    public string Agent { get; set; } = FromName(agent) ?? "claude";

    public string Root => root;

    public static string? FromName(string? name)
    {
        string lower = (name ?? "").ToLowerInvariant();
        if (lower.Contains("codex", StringComparison.Ordinal) || lower.Contains("chatgpt", StringComparison.Ordinal)) return "codex";
        if (lower.Contains("claude", StringComparison.Ordinal)) return "claude";
        if (lower.Contains("antigravity", StringComparison.Ordinal) || lower.Contains("gemini", StringComparison.Ordinal) || lower.Contains("jetski", StringComparison.Ordinal)) return "antigravity";
        return null;
    }

    /// <summary>
    /// Issue of a failed call: `~` when it may have acted (outcome to inspect), `refus` for a path-policy refusal
    /// (nothing sent to InDesign), `✗` otherwise.
    /// </summary>
    public static string IssueOf(string code, bool requiresInspection) => requiresInspection || code.EndsWith("OUTCOME_UNKNOWN", StringComparison.Ordinal)
        ? "~"
        : code is "PATH_DENIED" or "PATH_OUTSIDE_ROOTS" or "PATH_EXTENSION_DENIED" or "TARGET_EXISTS" or "ACCESS_DENIED" ? "refus" : "✗";

    public void Write(string action, string issue, double ms, string? technique = null, string? errorCode = null, string? operationId = null)
    {
        if (Environment.GetEnvironmentVariable("NEXUS_JOURNAL") is "0" or "off" or "false" or "no") return;
        try
        {
            var now = DateTimeOffset.UtcNow;
            string? code = errorCode is { Length: > 0 } c ? new string(c.Where(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_').Take(80).ToArray()) : null;
            var row = new JsonObject
            {
                ["v"] = 1,
                ["ts"] = now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                ["agent"] = Agent,
                ["outil"] = Program.Version,
                ["appel"] = operationId is { Length: > 0 and <= 64 } op && op.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_') ? op : null,
                ["app"] = "indesign.exe",
                ["cadre"] = null,
                ["action"] = action,
                ["technique"] = technique,
                ["issue"] = issue,
                ["ms"] = (int)Math.Round(Math.Max(0, ms)),
                ["premier_plan"] = false,
                ["erreur"] = issue is "✓" or "=" ? null : code ?? "error",
            };
            string dir = Path.Join(root, "indesign", Agent);
            string file = Path.Join(dir, $"{now:yyyy-MM}.jsonl");
            byte[] bytes = new UTF8Encoding(false).GetBytes(row.ToJsonString() + "\n");
            lock (Gate)
            {
                Directory.CreateDirectory(dir);
                using var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                stream.Write(bytes);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // The common journal never blocks nor breaks a tool.
        }
    }
}
