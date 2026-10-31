using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Workflows;

/// <summary>
/// Layout snapshot analysis: a fingerprint of the layout (identity fields removed, collections sorted) and a lint
/// against an optional contract (overset text, links, fonts, effective PPI, margins, page sizes, required styles...).
/// </summary>
internal static partial class LayoutWorkflow
{
    private const int MaxComparisonAnomalies = 200;

    [GeneratedRegex(@"missing|not\s*found|unavailable", RegexOptions.IgnoreCase)] private static partial Regex MissingLink();
    [GeneratedRegex(@"out.?of.?date|modified", RegexOptions.IgnoreCase)] private static partial Regex OutdatedLink();
    [GeneratedRegex(@"missing|not.?available|substitut", RegexOptions.IgnoreCase)] private static partial Regex MissingFont();

    private static JsonObject Projection(JsonObject snapshot)
    {
        var copy = (JsonObject)snapshot.DeepClone();
        foreach (string key in new[] { "success", "capturedAt", "documentId", "revision" }) copy.Remove(key);
        if (copy["document"] is JsonObject document)
            foreach (string key in new[] { "id", "name", "path", "modified" }) document.Remove(key);
        foreach (string collection in new[] { "pages", "items", "links", "images", "fonts" })
            if (copy[collection] is JsonArray array) copy[collection] = Sorted(array);
        if (copy["designSystem"] is JsonObject system)
            foreach (var key in system.Select(pair => pair.Key).ToList())
                if (system[key] is JsonArray array) system[key] = Sorted(array);
        return copy;
    }

    private static JsonArray Sorted(JsonArray array) =>
        Json.Array(array.Select(item => (Key: Json.Canonical(item), Item: item)).OrderBy(entry => entry.Key, StringComparer.Ordinal).Select(entry => entry.Item));

    public static string Fingerprint(JsonObject snapshot) => Json.Sha256(Json.Canonical(Projection(snapshot)));

    private static JsonObject Issue(string code, string severity, string message, JsonObject? details = null)
    {
        var issue = new JsonObject { ["code"] = code, ["severity"] = severity, ["message"] = message };
        return details is null ? issue : Json.Merge(issue, details);
    }

    private static double? Number(JsonNode? node) => Json.Number(node);

    private static IEnumerable<JsonObject> Objects(JsonNode? node) => (node as JsonArray ?? []).OfType<JsonObject>();

    private static string StatusText(JsonObject entry) => (entry["statusName"] ?? entry["status"])?.ToString() ?? "";

    private static HashSet<string> Names(JsonNode? collection) =>
        Objects(collection).Select(entry => entry["name"]?.ToString().ToLowerInvariant() ?? "").Where(name => name.Length > 0).ToHashSet(StringComparer.Ordinal);

    public static JsonObject Lint(JsonObject snapshot, JsonObject contract)
    {
        var issues = new List<JsonObject>();
        var pages = Objects(snapshot["pages"]).ToList();
        var items = Objects(snapshot["items"]).ToList();
        var designSystem = snapshot["designSystem"] as JsonObject ?? [];
        bool Allowed(string flag) => Json.IsTrue(contract, flag);

        if (Json.IsTrue(snapshot, "truncated") && Json.Bool(contract, "requireCompleteSnapshot") != false)
            issues.Add(Issue("SNAPSHOT_TRUNCATED", "error", "Le diagnostic a atteint la limite d’objets ; une validation exhaustive est impossible.",
                new JsonObject { ["totalItems"] = snapshot["totalItems"]?.DeepClone(), ["inspectedItems"] = items.Count }));
        if (!Allowed("allowOversetText"))
            foreach (var item in items.Where(entry => Json.IsTrue(entry, "overflows")))
                issues.Add(Issue("OVERSET_TEXT", "error", "Un bloc de texte déborde.", new JsonObject { ["pageId"] = item["pageId"]?.DeepClone(), ["itemId"] = item["id"]?.DeepClone() }));
        var links = Objects(snapshot["links"]).ToList();
        if (!Allowed("allowMissingLinks"))
            foreach (var link in links.Where(entry => MissingLink().IsMatch(StatusText(entry))))
                issues.Add(Issue("MISSING_LINK", "error", "Un lien placé est manquant.", new JsonObject { ["linkId"] = link["id"]?.DeepClone(), ["name"] = link["name"]?.DeepClone() }));
        foreach (var link in links.Where(entry => OutdatedLink().IsMatch(StatusText(entry))))
            issues.Add(Issue("OUTDATED_LINK", Allowed("allowOutdatedLinks") ? "warning" : "error", "Un lien placé n’est pas à jour.",
                new JsonObject { ["linkId"] = link["id"]?.DeepClone(), ["name"] = link["name"]?.DeepClone() }));
        var fonts = Objects(snapshot["fonts"]).ToList();
        if (!Allowed("allowMissingFonts"))
            foreach (var font in fonts.Where(entry => MissingFont().IsMatch(StatusText(entry))))
                issues.Add(Issue("MISSING_FONT", "error", "Une police utilisée est indisponible ou substituée.", new JsonObject { ["name"] = font["name"]?.DeepClone() }));
        if (Number(contract["minEffectivePpi"]) is double minPpi)
        {
            foreach (var image in Objects(snapshot["images"]))
            {
                var values = (image["effectivePpi"] as JsonArray ?? []).Select(Number).OfType<double>().ToList();
                if (values.Count > 0 && values.Min() < minPpi)
                    issues.Add(Issue("LOW_EFFECTIVE_PPI", "error", "La résolution effective d’une image est inférieure au contrat.", new JsonObject
                    {
                        ["imageId"] = image["id"]?.DeepClone(), ["pageId"] = image["pageId"]?.DeepClone(), ["effectivePpi"] = values.Min(), ["requiredPpi"] = minPpi,
                    }));
            }
        }
        if (Number(contract["minMarginMm"]) is double minMargin)
        {
            foreach (var page in pages)
            {
                var margins = (page["margins"] as JsonObject ?? []).Select(pair => Number(pair.Value)).OfType<double>();
                if (margins.Any(value => value < minMargin))
                    issues.Add(Issue("MARGIN_BELOW_CONTRACT", "error", "Une marge de page est inférieure au contrat.", new JsonObject
                    {
                        ["pageId"] = page["id"]?.DeepClone(), ["margins"] = page["margins"]?.DeepClone(), ["requiredMm"] = minMargin,
                    }));
            }
        }
        var sizes = Objects(contract["allowedPageSizes"]).ToList();
        if (sizes.Count > 0)
        {
            foreach (var page in pages)
            {
                double width = Number(page["widthMm"]) ?? double.NaN, height = Number(page["heightMm"]) ?? double.NaN;
                bool matches = sizes.Any(candidate =>
                {
                    double tolerance = Number(candidate["toleranceMm"]) ?? 0.5;
                    double cw = Number(candidate["widthMm"]) ?? double.NaN, ch = Number(candidate["heightMm"]) ?? double.NaN;
                    bool direct = Math.Abs(width - cw) <= tolerance && Math.Abs(height - ch) <= tolerance;
                    bool rotated = Json.Bool(candidate, "allowRotation") != false && Math.Abs(width - ch) <= tolerance && Math.Abs(height - cw) <= tolerance;
                    return direct || rotated;
                });
                if (!matches)
                    issues.Add(Issue("PAGE_SIZE_NOT_ALLOWED", "error", "Le format d’une page ne correspond à aucun format autorisé.", new JsonObject
                    {
                        ["pageId"] = page["id"]?.DeepClone(), ["widthMm"] = page["widthMm"]?.DeepClone(), ["heightMm"] = page["heightMm"]?.DeepClone(),
                    }));
            }
        }
        if (Json.Bool(contract, "requireFacingPages") is bool facing && Json.IsTrue(snapshot["document"], "facingPages") != facing)
            issues.Add(Issue("FACING_PAGES_MISMATCH", "error", "Le réglage des pages en vis-à-vis ne respecte pas le contrat.",
                new JsonObject { ["actual"] = Json.IsTrue(snapshot["document"], "facingPages"), ["expected"] = facing }));
        if (Json.Long(contract, "maxPages") is long maxPages && pages.Count > maxPages)
            issues.Add(Issue("TOO_MANY_PAGES", "error", "Le document dépasse le nombre de pages autorisé.", new JsonObject { ["actual"] = pages.Count, ["maximum"] = maxPages }));
        int swatches = (designSystem["swatches"] as JsonArray)?.Count ?? 0;
        if (Json.Long(contract, "maxColors") is long maxColors && swatches > maxColors)
            issues.Add(Issue("TOO_MANY_SWATCHES", "warning", "Le document dépasse le nombre de nuances prévu par le contrat.", new JsonObject { ["actual"] = swatches, ["maximum"] = maxColors }));
        foreach (var (field, collection, code, message) in new[]
        {
            ("requiredLayers", "layers", "REQUIRED_LAYER_MISSING", "Un calque requis est absent."),
            ("requiredParagraphStyles", "paragraphStyles", "REQUIRED_PARAGRAPH_STYLE_MISSING", "Un style de paragraphe requis est absent."),
            ("requiredCharacterStyles", "characterStyles", "REQUIRED_CHARACTER_STYLE_MISSING", "Un style de caractère requis est absent."),
            ("requiredObjectStyles", "objectStyles", "REQUIRED_OBJECT_STYLE_MISSING", "Un style d’objet requis est absent."),
        })
        {
            var existing = Names(designSystem[collection]);
            foreach (var required in (contract[field] as JsonArray ?? []).Select(entry => entry?.ToString() ?? ""))
                if (!existing.Contains(required.ToLowerInvariant())) issues.Add(Issue(code, "error", message, new JsonObject { ["name"] = required }));
        }
        var allowedFonts = (contract["allowedFonts"] as JsonArray ?? []).Select(entry => entry?.ToString().ToLowerInvariant() ?? "").ToHashSet(StringComparer.Ordinal);
        if (allowedFonts.Count > 0)
            foreach (var font in fonts)
            {
                var identifiers = new[] { font["name"]?.ToString(), font["family"]?.ToString() }.Where(entry => !string.IsNullOrEmpty(entry)).Select(entry => entry!.ToLowerInvariant());
                if (!identifiers.Any(allowedFonts.Contains))
                    issues.Add(Issue("FONT_NOT_ALLOWED", "error", "Une police utilisée ne figure pas dans le contrat.", new JsonObject { ["name"] = font["name"]?.DeepClone(), ["family"] = font["family"]?.DeepClone() }));
            }
        if (Number(contract["minimumStylePointSizePt"]) is double minimumPt)
            foreach (var style in Objects(designSystem["paragraphStyles"]).Concat(Objects(designSystem["characterStyles"])))
                if (Number(style["pointSize"]) is double size && size > 0 && size < minimumPt)
                    issues.Add(Issue("STYLE_TEXT_TOO_SMALL", "warning", "Un style typographique utilise un corps inférieur au contrat.", new JsonObject
                    {
                        ["name"] = style["name"]?.DeepClone(), ["pointSize"] = size, ["minimumPt"] = minimumPt,
                    }));
        if (snapshot["typography"] is JsonObject typography) issues.AddRange(TypographyIssues(typography));
        foreach (var item in items)
        {
            var bounds = (item["bounds"] as JsonArray ?? []).Select(Number).ToList();
            bool valid = bounds.Count == 4 && bounds.All(value => value is not null);
            double height = valid ? bounds[2]!.Value - bounds[0]!.Value : double.NaN, width = valid ? bounds[3]!.Value - bounds[1]!.Value : double.NaN;
            bool line = string.Equals(item["type"]?.ToString(), "graphicline", StringComparison.OrdinalIgnoreCase);
            bool invalid = !valid || height < 0 || width < 0 || (line ? height == 0 && width == 0 : height <= 0 || width <= 0);
            if (invalid)
            {
                issues.Add(Issue("INVALID_ITEM_GEOMETRY", "error", "Un objet possède une géométrie invalide.", new JsonObject
                {
                    ["pageId"] = item["pageId"]?.DeepClone(), ["itemId"] = item["id"]?.DeepClone(), ["bounds"] = item["bounds"]?.DeepClone(),
                }));
                continue;
            }
            if (Number(contract["maxOutsidePageMm"]) is double limit && item["pageId"] is not null)
            {
                var page = pages.FirstOrDefault(entry => Json.Canonical(entry["id"]) == Json.Canonical(item["pageId"]));
                var pageBounds = (page?["bounds"] as JsonArray ?? []).Select(Number).ToList();
                if (pageBounds.Count == 4 && pageBounds.All(value => value is not null))
                {
                    bool outside = bounds[0] < pageBounds[0] - limit || bounds[1] < pageBounds[1] - limit || bounds[2] > pageBounds[2] + limit || bounds[3] > pageBounds[3] + limit;
                    if (outside)
                        issues.Add(Issue("ITEM_OUTSIDE_PAGE_LIMIT", "warning", "Un objet dépasse la page au-delà de la tolérance du contrat.", new JsonObject
                        {
                            ["pageId"] = item["pageId"]?.DeepClone(), ["itemId"] = item["id"]?.DeepClone(), ["bounds"] = item["bounds"]?.DeepClone(), ["toleranceMm"] = limit,
                        }));
                }
            }
        }
        int errors = issues.Count(issue => issue["severity"]!.ToString() == "error");
        int warnings = issues.Count - errors;
        return new JsonObject
        {
            ["passed"] = errors == 0,
            ["counts"] = new JsonObject { ["error"] = errors, ["warning"] = warnings },
            ["issues"] = Json.Array(issues),
            ["contractApplied"] = contract.DeepClone(),
        };
    }

    /// <summary>
    /// Read-only typographic audit (warnings, never blocking): local overrides of a paragraph style, text left in the
    /// default styles, one style rendered at several sizes or leadings, leading tighter than the type size.
    /// </summary>
    private static IEnumerable<JsonObject> TypographyIssues(JsonObject typography)
    {
        static JsonNode? Clone(JsonNode? node) => node?.DeepClone();
        if (Json.IsTrue(typography, "truncated"))
            yield return Issue("TYPOGRAPHY_AUDIT_TRUNCATED", "warning", "L’audit typographique a atteint la limite de paragraphes ; certains récits n’ont pas été lus.",
                new JsonObject { ["inspectedParagraphs"] = Clone(typography["inspectedParagraphs"]), ["totalParagraphs"] = Clone(typography["totalParagraphs"]) });
        foreach (var style in Objects(typography["styles"]))
        {
            var details = new JsonObject { ["style"] = Clone(style["name"]), ["styleId"] = Clone(style["id"]) };
            if (Json.Long(style, "overridden") is > 0)
                yield return Issue("STYLE_OVERRIDE", "warning", "Des paragraphes portent des remplacements locaux par rapport à leur style.", Json.Merge((JsonObject)details.DeepClone(),
                    new JsonObject { ["paragraphs"] = Clone(style["overridden"]), ["storyIds"] = Clone(style["overriddenStoryIds"]) }));
            if ((style["pointSizes"] as JsonArray)?.Count > 1)
                yield return Issue("INCONSISTENT_POINT_SIZE", "warning", "Un même style de paragraphe est rendu dans plusieurs corps.", Json.Merge((JsonObject)details.DeepClone(),
                    new JsonObject { ["pointSizes"] = Clone(style["pointSizes"]), ["storyIds"] = Clone(style["storyIds"]) }));
            if ((style["leadings"] as JsonArray)?.Count > 1)
                yield return Issue("INCONSISTENT_LEADING", "warning", "Un même style de paragraphe est rendu avec plusieurs interlignages.", Json.Merge((JsonObject)details.DeepClone(),
                    new JsonObject { ["leadings"] = Clone(style["leadings"]), ["storyIds"] = Clone(style["storyIds"]) }));
        }
        if (Json.Long(typography["unstyled"], "paragraphs") is > 0)
            yield return Issue("UNSTYLED_TEXT", "warning", "Du texte reste dans le style par défaut ([Paragraphe standard] ou [Sans style de paragraphe]).",
                new JsonObject { ["paragraphs"] = Clone(typography["unstyled"]?["paragraphs"]), ["storyIds"] = Clone(typography["unstyled"]?["storyIds"]) });
        if (Json.Long(typography["tightLeading"], "paragraphs") is > 0)
            yield return Issue("LEADING_TIGHTER_THAN_SIZE", "warning", "L’interlignage de paragraphes est inférieur à leur corps (lignes qui se chevauchent).",
                new JsonObject { ["paragraphs"] = Clone(typography["tightLeading"]?["paragraphs"]), ["storyIds"] = Clone(typography["tightLeading"]?["storyIds"]) });
    }

    public static JsonObject Analyze(JsonObject snapshot, JsonObject? contract)
    {
        if (snapshot["document"] is null || snapshot["pages"] is not JsonArray pages || snapshot["items"] is not JsonArray items)
            throw new ToolError("LAYOUT_SNAPSHOT_INVALID", "Le diagnostic InDesign ne respecte pas le contrat de workflow.");
        var system = snapshot["designSystem"] as JsonObject;
        int Count(JsonNode? node) => (node as JsonArray)?.Count ?? 0;
        return new JsonObject
        {
            ["fingerprint"] = Fingerprint(snapshot),
            ["snapshot"] = snapshot.DeepClone(),
            ["lint"] = Lint(snapshot, contract ?? []),
            ["statistics"] = new JsonObject
            {
                ["pages"] = pages.Count, ["items"] = items.Count, ["totalItems"] = snapshot["totalItems"]?.DeepClone() ?? items.Count,
                ["links"] = Count(snapshot["links"]), ["images"] = Count(snapshot["images"]), ["fonts"] = Count(snapshot["fonts"]),
                ["layers"] = Count(system?["layers"]), ["paragraphStyles"] = Count(system?["paragraphStyles"]),
                ["characterStyles"] = Count(system?["characterStyles"]), ["objectStyles"] = Count(system?["objectStyles"]),
                ["swatches"] = Count(system?["swatches"]),
            },
        };
    }

    public static JsonObject SummarizeAnomalies(JsonObject? lint)
    {
        var issues = Objects(lint?["issues"]).ToList();
        var byCode = issues.GroupBy(issue => issue["code"]?.ToString() ?? "UNKNOWN").OrderBy(group => group.Key, StringComparer.Ordinal);
        var counts = new JsonObject();
        foreach (var group in byCode) counts[group.Key] = group.Count();
        var items = issues.Take(MaxComparisonAnomalies).ToList();
        return new JsonObject
        {
            ["total"] = issues.Count, ["returned"] = items.Count, ["truncated"] = items.Count < issues.Count,
            ["counts"] = lint?["counts"]?.DeepClone() ?? new JsonObject { ["error"] = 0, ["warning"] = 0 },
            ["byCode"] = counts, ["items"] = Json.Array(items),
        };
    }
}
