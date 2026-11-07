using System.Globalization;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Discovery;

/// <summary>
/// Offline search of Adobe's official InDesign DOM sitemap (AdobeDocs/uxp-indesign, Apache-2.0), embedded and pinned
/// by SHA-256: only https://developer.adobe.com/indesign/dom/api/... links are ever returned.
/// </summary>
internal static partial class DomIndex
{
    private const string SourceSha256 = "c1b0d48666943c69847556a26e52b13f3d2a43b7b0efa410802e2c71c0a32331";

    private sealed record Entry(string Name, string Url, string LastModified, string Normalized);

    private static readonly Lazy<(List<Entry> Entries, string Latest)> Index = new(Parse);

    [GeneratedRegex(@"<url>\s*<loc>([^<]+)</loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})</lastmod>\s*</url>")] private static partial Regex UrlEntry();
    [GeneratedRegex("^[A-Za-z][A-Za-z0-9]*$")] private static partial Regex ClassName();

    public static JsonObject Source() => new()
    {
        ["repository"] = "https://github.com/AdobeDocs/uxp-indesign",
        ["commit"] = "ba9d36134a4c2ee72dc03e16bbac3144e1263327",
        ["file"] = "indesign-dom-paths.xml",
        ["license"] = "Apache-2.0",
        ["sha256"] = SourceSha256,
    };

    private static string Normalize(string value)
    {
        var builder = new StringBuilder();
        foreach (char c in value.Normalize(NormalizationForm.FormKD))
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            if (category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark) continue;
            if (char.IsLetterOrDigit(c)) builder.Append(char.ToLowerInvariant(c));
        }
        return builder.ToString();
    }

    private static (List<Entry>, string) Parse()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("indesign-dom-paths.xml")
            ?? throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The Adobe DOM index is missing from the engine.", "L’index DOM Adobe est absent du moteur."));
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        byte[] bytes = memory.ToArray();
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != SourceSha256)
            throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The embedded Adobe DOM index does not match its pinned official hash.", "L’index DOM Adobe embarqué ne correspond pas à son empreinte officielle épinglée."));
        var entries = new List<Entry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in UrlEntry().Matches(Encoding.UTF8.GetString(bytes)))
        {
            var url = new Uri(WebUtility.HtmlDecode(match.Groups[1].Value));
            if (url.Scheme != "https" || url.Host != "developer.adobe.com" || url.UserInfo.Length > 0 || url.Query.Length > 0 || url.Fragment.Length > 0)
                throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The Adobe DOM index contains a URL outside the allowed official domain.", "L’index DOM Adobe contient une URL hors du domaine officiel autorisé."));
            var parts = url.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            bool prefix = parts.Length >= 3 && parts[0] == "indesign" && parts[1] == "dom" && parts[2] == "api";
            if (prefix && (parts.Length == 3 || (parts.Length == 4 && parts[3].Length == 1))) continue;
            if (parts.Length != 5 || !prefix || parts[3].Length != 1)
                throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The Adobe DOM index contains an unexpected path.", "L’index DOM Adobe contient un chemin inattendu."));
            string name = Uri.UnescapeDataString(parts[4]);
            if (!ClassName().IsMatch(name) || !seen.Add(name))
                throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The Adobe DOM index contains an invalid or duplicate name.", "L’index DOM Adobe contient un nom invalide ou dupliqué."));
            entries.Add(new Entry(name, url.AbsoluteUri, match.Groups[2].Value, Normalize(name)));
        }
        if (entries.Count < 1_000) throw new ToolError("OFFICIAL_DOM_INDEX_INVALID", Strings.T("The embedded Adobe DOM index is incomplete.", "L’index DOM Adobe embarqué est incomplet."));
        entries.Sort((left, right) => string.CompareOrdinal(left.Name, right.Name));
        return (entries, entries.Max(entry => entry.LastModified) ?? "");
    }

    public static JsonObject Info() => new()
    {
        ["source"] = Source(),
        ["entryCount"] = Index.Value.Entries.Count,
        ["latestModification"] = Index.Value.Latest,
    };

    public static JsonObject Search(string query, int limit = 10)
    {
        string text = query.Trim();
        string normalized = Normalize(text);
        var output = Info();
        output["query"] = text;
        if (normalized.Length == 0)
        {
            output["matchCount"] = 0;
            output["matches"] = new JsonArray();
            return output;
        }
        int Score(Entry entry)
        {
            if (entry.Name.Equals(text, StringComparison.OrdinalIgnoreCase)) return 0;
            if (entry.Normalized == normalized) return 1;
            if (entry.Normalized.StartsWith(normalized, StringComparison.Ordinal)) return 2;
            return entry.Normalized.Contains(normalized, StringComparison.Ordinal) ? 3 : int.MaxValue;
        }
        var ranked = Index.Value.Entries.Select(entry => (Entry: entry, Score: Score(entry))).Where(candidate => candidate.Score != int.MaxValue)
            .OrderBy(candidate => candidate.Score).ThenBy(candidate => candidate.Entry.Name, StringComparer.Ordinal).ToList();
        output["matchCount"] = ranked.Count;
        output["matches"] = Json.Array(ranked.Take(limit).Select(candidate => (JsonNode)new JsonObject
        {
            ["name"] = candidate.Entry.Name, ["url"] = candidate.Entry.Url, ["lastModified"] = candidate.Entry.LastModified,
        }));
        return output;
    }
}
