using System.Text.Json.Nodes;

namespace NexusInDesign.Tests;

/// <summary>
/// Common journal of the Nexus tools (NexusShared/journal/FORMAT.md v1): every tool call writes one short line, so
/// NexusSystem and `NexusJournal revue` see the activity, and the journal cannot go silent unnoticed. Never a path.
/// </summary>
public sealed class CommonJournalTests
{
    private static List<JsonObject> Lines(Sandbox sandbox, string agent = "claude")
    {
        string file = Path.Combine(sandbox.Profile, ".nexus", "journal", "indesign", agent, $"{DateTime.UtcNow:yyyy-MM}.jsonl");
        return File.Exists(file) ? File.ReadAllLines(file).Select(line => JsonNode.Parse(line)!.AsObject()).ToList() : [];
    }

    private static void AssertFormat(JsonObject line, string action, string issue)
    {
        Assert.Equal(1, line["v"]!.GetValue<int>());
        Assert.Equal("claude", line["agent"]!.GetValue<string>());
        Assert.Equal(Program.Version, line["outil"]!.GetValue<string>());
        Assert.Equal("indesign.exe", line["app"]!.GetValue<string>());
        Assert.Equal(action, line["action"]!.GetValue<string>());
        Assert.Equal(issue, line["issue"]!.GetValue<string>());
        Assert.True(line["ms"]!.GetValue<int>() >= 0);
        Assert.True(line.ContainsKey("erreur") && line.ContainsKey("appel") && line.ContainsKey("technique"));
        Assert.True(DateTimeOffset.TryParse(line["ts"]!.GetValue<string>(), out _));
    }

    [Fact]
    public async Task Each_tool_call_writes_one_common_line_with_its_issue_and_stable_error_code()
    {
        using var sandbox = new Sandbox();
        string source = sandbox.Path("brochure.indd");
        Samples.WriteIndd(source, "source");
        await sandbox.Ok("open_document", new JsonObject { ["expectedRevision"] = 0, ["path"] = source });
        string denied = Path.Combine(sandbox.Secret, "hidden.indd");
        Samples.WriteIndd(denied, "secret");
        await sandbox.Fails("open_document", new JsonObject { ["expectedRevision"] = 0, ["path"] = denied });

        var lines = Lines(sandbox);
        Assert.Equal(2, lines.Count);
        AssertFormat(lines[0], "open_document", "✓");
        Assert.Null(lines[0]["erreur"]);
        AssertFormat(lines[1], "open_document", "refus");
        Assert.Equal("PATH_DENIED", lines[1]["erreur"]!.GetValue<string>());
        string all = string.Join('\n', lines.Select(line => line.ToJsonString()));
        Assert.DoesNotContain("brochure", all, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("hidden", all, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("claude-code", "claude")]
    [InlineData("codex-mcp-client", "codex")]
    [InlineData("antigravity", "antigravity")]
    [InlineData("claude.exe", "claude")]
    [InlineData("codex.exe", "codex")]
    [InlineData("unknown", null)]
    public void Agent_comes_from_the_client_or_the_verified_parent(string name, string? expected)
        => Assert.Equal(expected, Security.CommonJournal.FromName(name));
}
