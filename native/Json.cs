using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign;

/// <summary>Small JSON helpers shared by the engine (System.Text.Json nodes only).</summary>
internal static partial class Json
{
    public static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    [GeneratedRegex("^[a-f0-9]{16}$")] public static partial Regex StateToken();
    [GeneratedRegex("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")] public static partial Regex Uuid();
    [GeneratedRegex("^(?:[a-f0-9]{36}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$")] public static partial Regex BackupId();
    [GeneratedRegex("^[a-f0-9]{64}$")] public static partial Regex Sha256Hex();

    public static string NewId() => Guid.NewGuid().ToString("D");

    public static string? Str(JsonNode? node, string name) =>
        node is JsonObject obj && obj[name] is JsonValue value && value.TryGetValue(out string? text) ? text : null;

    public static long? Long(JsonNode? node, string name)
    {
        if (node is not JsonObject obj || obj[name] is not JsonValue value || value.GetValueKind() != JsonValueKind.Number) return null;
        string text = value.ToJsonString();
        if (long.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out long number)) return number;
        if (double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double real)
            && Math.Abs(real % 1) < double.Epsilon && Math.Abs(real) < 9007199254740992) return (long)real;
        return null;
    }

    /// <summary>A JSON number as double, whatever CLR type backs the node (parsed text, int, uint...).</summary>
    public static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value || value.GetValueKind() != JsonValueKind.Number) return null;
        return double.TryParse(value.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double number)
            && double.IsFinite(number) ? number : null;
    }

    public static bool? Bool(JsonNode? node, string name) =>
        node is JsonObject obj && obj[name] is JsonValue value && value.TryGetValue(out bool flag) ? flag : null;

    public static bool IsTrue(JsonNode? node, string name) => Bool(node, name) == true;

    public static void SetIfNotNull(JsonObject target, string name, string? value)
    {
        if (value is not null) target[name] = value;
    }

    public static void SetIfNotNull(JsonObject target, string name, JsonNode? value)
    {
        if (value is not null) target[name] = value.DeepClone();
    }

    /// <summary>A JavaScript literal of the value (JSON, with U+2028/U+2029 escaped as JavaScript requires).</summary>
    public static string Literal(object? value)
    {
        string json = value switch
        {
            null => "null",
            JsonNode node => node.ToJsonString(Compact),
            string text => JsonSerializer.Serialize(text, Compact),
            bool flag => flag ? "true" : "false",
            long or int => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)!,
            double number => JsonSerializer.Serialize(number, Compact),
            _ => JsonSerializer.Serialize(value, Compact),
        };
        return json.Replace("\u2028", "\\u2028", StringComparison.Ordinal).Replace("\u2029", "\\u2029", StringComparison.Ordinal);
    }

    public static JsonObject Merge(JsonObject target, JsonObject? source)
    {
        if (source is null) return target;
        foreach (var (key, value) in source) target[key] = value?.DeepClone();
        return target;
    }

    /// <summary>An object result as is, any other value wrapped as { value }.</summary>
    public static JsonObject AsObject(JsonNode? node) => node is JsonObject obj ? obj : new JsonObject { ["value"] = node?.DeepClone() };

    public static string Sha256(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    public static string Sha256File(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    /// <summary>Canonical JSON (object keys sorted ordinally), used for fingerprints and stable comparisons.</summary>
    public static string Canonical(JsonNode? node)
    {
        var builder = new StringBuilder();
        WriteCanonical(builder, node);
        return builder.ToString();
    }

    private static void WriteCanonical(StringBuilder builder, JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                builder.Append('{');
                bool first = true;
                foreach (var (key, value) in obj.OrderBy(entry => entry.Key, StringComparer.Ordinal))
                {
                    if (!first) builder.Append(',');
                    first = false;
                    builder.Append(JsonSerializer.Serialize(key, Compact)).Append(':');
                    WriteCanonical(builder, value);
                }
                builder.Append('}');
                break;
            case JsonArray array:
                builder.Append('[');
                for (int index = 0; index < array.Count; index++)
                {
                    if (index > 0) builder.Append(',');
                    WriteCanonical(builder, array[index]);
                }
                builder.Append(']');
                break;
            case null:
                builder.Append("null");
                break;
            default:
                builder.Append(node.ToJsonString(Compact));
                break;
        }
    }

    public static JsonArray Array(IEnumerable<JsonNode?> items)
    {
        var array = new JsonArray();
        foreach (var item in items) array.Add(item?.DeepClone());
        return array;
    }
}
