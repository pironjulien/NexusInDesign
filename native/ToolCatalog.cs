using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

namespace NexusInDesign;

/// <summary>A tool contract: what the agent sees (name, schema, annotations) and how the engine routes it.</summary>
internal sealed record ToolContract(string Name, JsonObject Public, JsonObject InputSchema, string Route, bool MutatesDocument, bool Destructive,
    IReadOnlyList<PathRule> PathRules, JsonSchema Schema);

internal sealed record PathRule(string Field, string Access, IReadOnlyList<string> Extensions, string Kind, bool MustNotExist);

/// <summary>The 32 tools of the core profile, from the embedded tool-contracts.json, with JSON Schema 2020-12 checks.</summary>
internal sealed class ToolCatalog
{
    private readonly Dictionary<string, ToolContract> byName = new(StringComparer.Ordinal);
    private static readonly Lazy<ToolCatalog> Instance = new(() => new ToolCatalog());

    /// <summary>The contracts, compiled once per process (schemas live in JsonSchema.Net's global registry).</summary>
    public static ToolCatalog Shared => Instance.Value;

    private ToolCatalog()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("tool-contracts.json")
            ?? throw new InvalidOperationException("Tool contracts missing.");
        foreach (var node in JsonNode.Parse(stream)!.AsArray().OfType<JsonObject>())
        {
            string name = node["name"]!.GetValue<string>();
            var schema = (JsonObject)node["inputSchema"]!;
            var meta = node["_meta"] as JsonObject ?? [];
            var rules = (meta["pathRules"] as JsonArray ?? []).OfType<JsonObject>().Select(rule => new PathRule(
                rule["field"]!.GetValue<string>(),
                rule["access"]!.GetValue<string>(),
                (rule["extensions"] as JsonArray ?? []).Select(entry => entry!.GetValue<string>()).ToList(),
                rule["kind"]?.GetValue<string>() ?? "file",
                rule["mustNotExist"]?.GetValue<bool>() == true)).ToList();
            var visible = new JsonObject
            {
                ["name"] = name,
                ["title"] = node["title"]?.DeepClone(),
                ["description"] = node["description"]?.DeepClone(),
                ["inputSchema"] = schema.DeepClone(),
                ["annotations"] = node["annotations"]?.DeepClone(),
            };
            var compiled = JsonSchema.FromText(schema.ToJsonString(), baseUri: new Uri($"urn:nexus-indesign:tool:{name}"));
            byName[name] = new ToolContract(name, visible, schema, meta["route"]?.GetValue<string>() ?? "silent",
                meta["mutatesDocument"]?.GetValue<bool>() == true, node["annotations"]?["destructiveHint"]?.GetValue<bool>() == true, rules, compiled);
        }
    }

    public IReadOnlyCollection<ToolContract> Tools => byName.Values;

    public ToolContract? Find(string name) => byName.GetValueOrDefault(name);

    public JsonArray PublicList() => Json.Array(byName.Values.OrderBy(tool => tool.Name, StringComparer.Ordinal).Select(tool => (JsonNode)tool.Public));

    /// <summary>Defaults of the properties, at every level of an object that is present (as Ajv useDefaults does).</summary>
    private static void ApplyDefaults(JsonObject schema, JsonObject instance)
    {
        if (schema["properties"] is not JsonObject properties) return;
        foreach (var (key, property) in properties)
        {
            if (property is not JsonObject definition) continue;
            if (!instance.ContainsKey(key) && definition.TryGetPropertyValue("default", out var fallback)) instance[key] = fallback?.DeepClone();
            if (instance[key] is JsonObject child) ApplyDefaults(definition, child);
        }
    }

    /// <summary>Defaults of the schema's properties applied, then the arguments checked; null when valid.</summary>
    public static string? Validate(ToolContract tool, JsonObject arguments)
    {
        ApplyDefaults(tool.InputSchema, arguments);
        using var document = JsonDocument.Parse(arguments.ToJsonString());
        var result = tool.Schema.Evaluate(document.RootElement, new EvaluationOptions { OutputFormat = OutputFormat.List });
        if (result.IsValid) return null;
        var messages = new List<string>();
        foreach (var detail in result.Details ?? [])
        {
            if (detail.Errors is null) continue;
            foreach (var (_, message) in detail.Errors)
            {
                string location = detail.InstanceLocation.ToString();
                messages.Add($"{(location.Length == 0 ? "/" : location)} {message}");
            }
        }
        if (messages.Count == 0 && result.Errors is not null) messages.AddRange(result.Errors.Select(error => $"/ {error.Value}"));
        return messages.Count == 0 ? "/ arguments invalides" : string.Join("; ", messages.Distinct().Take(20));
    }
}
