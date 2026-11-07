using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusInDesign.InDesign;

namespace NexusInDesign.Tests;

/// <summary>Sets the display language for the current test's async flow, then puts the previous one back.</summary>
internal sealed class DisplayLanguage : IDisposable
{
    private readonly CultureInfo previous = CultureInfo.CurrentUICulture;

    public DisplayLanguage(string name) => CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(name);

    public void Dispose() => CultureInfo.CurrentUICulture = previous;
}

public sealed partial class LanguageTests
{
    [Theory]
    [InlineData("en-US", "This server gives the agent", "Invalid arguments", "Quick layout script")]
    [InlineData("fr-FR", "Ce serveur donne à l’agent", "Paramètres invalides", "Script de mise en page rapide")]
    public async Task The_engine_speaks_the_display_language(string culture, string instructions, string invalid, string title)
    {
        using var language = new DisplayLanguage(culture);
        using var sandbox = new Sandbox();
        var input = new StringReader(string.Join("\n",
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "initialize", ["params"] = new JsonObject { ["protocolVersion"] = "2025-06-18" } }.ToJsonString(),
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 2, ["method"] = "tools/list" }.ToJsonString(),
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 3, ["method"] = "tools/call", ["params"] = new JsonObject { ["name"] = "run_layout_script", ["arguments"] = new JsonObject { ["documentId"] = 1 } } }.ToJsonString()) + "\n");
        var output = new StringWriter();
        await new McpServer(sandbox.App).RunStdio(input, output, TestContext.Current.CancellationToken);
        var responses = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => (JsonObject)JsonNode.Parse(line)!)
            .OrderBy(message => Json.Long(message, "id")).ToList();

        Assert.StartsWith(instructions, Json.Str(responses[0]["result"], "instructions"));
        var tool = ((JsonArray)responses[1]["result"]!["tools"]!).OfType<JsonObject>().Single(entry => Json.Str(entry, "name") == "run_layout_script");
        Assert.Equal(title, Json.Str(tool, "title"));
        Assert.Contains(invalid, responses[2]["result"]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Contains($"const __fr = {(culture.StartsWith("fr", StringComparison.Ordinal) ? "true" : "false")};", UxpTemplates.SyncScript("return 1;"));
    }

    [Fact]
    public void The_registry_hash_does_not_depend_on_the_language()
    {
        string Hash(string culture)
        {
            using var language = new DisplayLanguage(culture);
            return Json.Sha256(Json.Canonical(ToolCatalog.Shared.PublicList(french: false)));
        }
        Assert.Equal(Hash("en-US"), Hash("fr-FR"));
        Assert.NotEqual(ToolCatalog.Shared.PublicList(french: false).ToJsonString(), ToolCatalog.Shared.PublicList(french: true).ToJsonString());
    }

    [Fact]
    public void Every_tool_text_is_English_with_a_French_translation()
    {
        var catalog = ToolCatalog.Shared;
        var texts = new HashSet<string>(StringComparer.Ordinal);
        void Walk(JsonNode? node)
        {
            if (node is JsonArray array) foreach (var item in array) Walk(item);
            if (node is not JsonObject obj) return;
            foreach (var (key, value) in obj)
                if (key is "title" or "description" && value is JsonValue text && text.TryGetValue(out string? english)) texts.Add(english);
                else Walk(value);
        }
        foreach (var tool in catalog.Tools) Walk(tool.Public);
        Assert.All(texts, text => Assert.DoesNotMatch(FrenchLetters(), text));
        Assert.All(texts, text => Assert.True(catalog.French.ContainsKey(text), $"No French text for: {text}"));
        Assert.All(catalog.French.Keys, key => Assert.Contains(key, texts));
    }

    /// <summary>Every accented French literal of the engine and its UXP scripts goes through Strings.T or __t.</summary>
    [Fact]
    public void No_engine_text_is_French_only()
    {
        var sources = Directory.EnumerateFiles(Repository.File("native"), "*.cs", SearchOption.AllDirectories)
            .Concat(Directory.EnumerateFiles(Repository.File("native", "uxp"), "*.js"))
            .Where(file => !file.EndsWith("Strings.cs", StringComparison.Ordinal));
        var untranslated = new List<string>();
        foreach (string file in sources)
            foreach (var (line, number) in File.ReadLines(file).Select((line, index) => (line, index + 1)))
                if (FrenchLetters().IsMatch(line) && !line.Contains("Strings.T(", StringComparison.Ordinal) && !line.Contains("__t(", StringComparison.Ordinal))
                    untranslated.Add($"{Path.GetFileName(file)}:{number}");
        Assert.Empty(untranslated);
    }

    [GeneratedRegex("[àâçéèêëîïôûùœ’«»ÀÉÈ]")]
    private static partial Regex FrenchLetters();
}
