using System.Reflection;
using System.Text.RegularExpressions;

namespace NexusInDesign.InDesign;

/// <summary>
/// The UXP (and one ExtendScript) programs InDesign runs through DoScript, embedded from native/uxp. A template names
/// its inputs as @@name@@; each is replaced by raw JavaScript (a literal built by <see cref="Json.Literal"/>, or a
/// fragment of another template). A missing input refuses the script before InDesign sees it. @@FRENCH@@ is true when
/// the engine speaks French (<see cref="Strings.French"/>), so the scripts' own messages follow the same language.
/// </summary>
internal static partial class UxpTemplates
{
    public const string RevisionLabel = "fr.pironjulien.indesign.mcp.revision";

    [GeneratedRegex("@@([A-Za-z_]+)@@")] private static partial Regex Token();

    private static readonly Dictionary<string, string> Cache = new(StringComparer.Ordinal);

    public static string Load(string name)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(name, out var cached)) return cached;
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"uxp/{name}")
                ?? throw new InvalidOperationException($"UXP template {name} is missing from the engine.");
            using var reader = new StreamReader(stream);
            string text = reader.ReadToEnd().Replace("\r\n", "\n", StringComparison.Ordinal);
            Cache[name] = text;
            return text;
        }
    }

    /// <summary>The template with every @@name@@ replaced. Shared fragments are always available.</summary>
    public static string Render(string name, IReadOnlyDictionary<string, string> values)
    {
        string text = Load(name);
        return Token().Replace(text, match =>
        {
            string key = match.Groups[1].Value;
            if (values.TryGetValue(key, out var value)) return value;
            return key switch
            {
                "STATE_FUNCTION" => Load("state-function.js").TrimEnd('\n'),
                "PROFILE_HELPERS" => Load("profile-helpers.js"),
                "AUDIT_FUNCTIONS" => Load("audit-functions.js").TrimEnd('\n'),
                "ANNOTATE_FUNCTIONS" => Load("annotate-functions.js").TrimEnd('\n'),
                "FRENCH" => Strings.French ? "true" : "false",
                _ => throw new ToolError("GENERATED_UXP_INPUT_MISSING", Strings.T($"The UXP script {name} expects the value {key}; it was not sent to InDesign.", $"Le script UXP {name} attend la valeur {key}; il n’a pas été envoyé à InDesign.")),
            };
        });
    }

    /// <summary>A body run synchronously by DoScript: its result comes back through script.setResult.</summary>
    public static string SyncScript(string body) =>
        Render("sync-envelope.js", new Dictionary<string, string> { ["body"] = body.TrimEnd('\n') });

    /// <summary>A body run asynchronously: it writes its result file, which the engine waits for.</summary>
    public static string AsyncScript(string body, string resultPath, long maxResultBytes, string operationId) =>
        Render("async-envelope.js", new Dictionary<string, string>
        {
            ["body"] = body.TrimEnd('\n'),
            ["resultPath"] = Json.Literal(UxpPath(resultPath)),
            ["maxResultBytes"] = maxResultBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["operationId"] = Json.Literal(operationId),
        });

    /// <summary>InDesign's UXP file APIs take forward slashes.</summary>
    public static string UxpPath(string path) => path.Replace('\\', '/');
}
