using System.Text.Json.Nodes;

namespace NexusInDesign.Tests;

public sealed class ProtocolTests
{
    private static readonly string[] PluginOnly =
    [
        "bridge_status", "bridge_open_pairing_window", "bridge_arm_pairing_clipboard", "bridge_operation_status",
        "execute_uxp", "restore_safety_backup", "close_document", "list_documents", "ping",
    ];

    private static async Task<List<JsonObject>> Exchange(Sandbox sandbox, params JsonObject[] requests)
    {
        var input = new StringReader(string.Join("\n", requests.Select(request => request.ToJsonString())) + "\n");
        var output = new StringWriter();
        await new McpServer(sandbox.App).RunStdio(input, output);
        return output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => (JsonObject)JsonNode.Parse(line)!)
            .OrderBy(message => Json.Long(message, "id") ?? -1).ToList();
    }

    [Fact]
    public async Task Initialize_lists_the_32_silent_tools_and_nothing_of_the_plugin()
    {
        using var sandbox = new Sandbox();
        var responses = await Exchange(sandbox,
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "initialize", ["params"] = new JsonObject { ["protocolVersion"] = "2025-06-18" } },
            new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "notifications/initialized" },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 2, ["method"] = "tools/list" },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 3, ["method"] = "ping" });
        Assert.Equal(3, responses.Count);
        var init = (JsonObject)responses[0]["result"]!;
        Assert.Equal("2025-06-18", Json.Str(init, "protocolVersion"));
        Assert.Equal("nexus-indesign", Json.Str(init["serverInfo"], "name"));
        Assert.Equal(Program.Version, Json.Str(init["serverInfo"], "version"));
        var tools = ((JsonArray)responses[1]["result"]!["tools"]!).OfType<JsonObject>().ToList();
        Assert.Equal(32, tools.Count);
        Assert.DoesNotContain(tools, tool => PluginOnly.Contains(Json.Str(tool, "name")));
        Assert.All(tools, tool => Assert.Null(tool["_meta"]));
        Assert.Contains(tools, tool => Json.Str(tool, "name") == "run_layout_script");
        Assert.Contains(tools, tool => Json.Str(tool, "name") == "export_idml");
        Assert.All(tools, tool => Assert.DoesNotMatch("plugin|appair|bridge_", tool.ToJsonString().ToLowerInvariant()));
    }

    [Fact]
    public async Task Invalid_arguments_and_unknown_tools_are_refused()
    {
        using var sandbox = new Sandbox();
        var responses = await Exchange(sandbox,
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "tools/call", ["params"] = new JsonObject { ["name"] = "nope", ["arguments"] = new JsonObject() } },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 2, ["method"] = "tools/call", ["params"] = new JsonObject { ["name"] = "run_layout_script", ["arguments"] = new JsonObject { ["documentId"] = 1 } } },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 3, ["method"] = "tools/call", ["params"] = new JsonObject
            {
                ["name"] = "run_layout_script",
                ["arguments"] = new JsonObject
                {
                    ["documentId"] = 1, ["expectedRevision"] = 0, ["expectedStateToken"] = "0123456789abcdef", ["reason"] = "Essai fermeture",
                    ["code"] = "return 1;", ["close"] = true,
                },
            } },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 4, ["method"] = "resources/list" });
        Assert.Equal(-32602, Json.Long(responses[0]["error"], "code"));
        Assert.True(Json.IsTrue(responses[1]["result"], "isError"));
        Assert.Contains("Paramètres invalides", responses[1]["result"]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.True(Json.IsTrue(responses[2]["result"], "isError"));
        Assert.Equal(-32601, Json.Long(responses[3]["error"], "code"));
        Assert.Empty(sandbox.InDesign.Runs);
    }

    [Fact]
    public void Public_argument_shapes_are_explicit_and_creation_arrays_remain_numeric()
    {
        var tools = ToolCatalog.Shared;
        foreach (string name in new[] { "run_layout_script", "export_png" })
        {
            var tool = tools.Find(name)!;
            var schema = tool.Public["inputSchema"]!;
            Assert.Equal("object", Json.Str(schema, "type"));
            Assert.NotNull(schema["properties"]!["documentId"]);
            Assert.Null(schema["allOf"]);
            Assert.NotNull(tool.InputSchema["allOf"]); // Conditional checks still run on the server.
        }
        var create = tools.Find("create_document")!;
        foreach (string name in new[] { "margins", "bleed" })
        {
            var array = create.Public["inputSchema"]!["properties"]![name]!;
            Assert.Equal("number", Json.Str(array["items"], "type"));
            Assert.Equal(4, Json.Long(array, "minItems"));
            Assert.Equal(4, Json.Long(array, "maxItems"));
            foreach (var invalid in new[] { "[1,2,3]", "[1,2,3,4,5]", "[1,2,-1,4]", "[\"1\",2,3,4]" })
            {
                var args = new JsonObject { ["expectedRevision"] = 0, ["width"] = 100, ["height"] = 100, [name] = JsonNode.Parse(invalid) };
                Assert.NotNull(ToolCatalog.Validate(create, args));
            }
        }
        Assert.Null(ToolCatalog.Validate(create, new JsonObject { ["expectedRevision"] = 0, ["width"] = 100, ["height"] = 100,
            ["margins"] = new JsonArray(1, 2, 3, 4), ["bleed"] = new JsonArray(0, 0, 0, 0) }));
    }

    [Fact]
    public async Task Doctor_reports_a_silent_channel_without_any_network_listener()
    {
        using var sandbox = new Sandbox();
        var doctor = await sandbox.Ok("indesign_doctor", new JsonObject { ["includeTools"] = true });
        Assert.Equal("ready-unverified", Json.Str(doctor, "status"));
        var checks = ((JsonArray)doctor["checks"]!).OfType<JsonObject>().ToDictionary(check => Json.Str(check, "id")!, check => Json.Str(check, "status"));
        Assert.Equal("pass", checks["no-network-listener"]);
        Assert.Equal("pass", checks["official-dom-index"]);
        Assert.Equal("pass", checks["private-storage"]);
        Assert.Equal(32, Json.Long(doctor["registry"], "toolCount"));
        Assert.Empty(sandbox.InDesign.Runs);
    }

    [Fact]
    public async Task Search_official_dom_returns_only_adobe_links()
    {
        using var sandbox = new Sandbox();
        var found = await sandbox.Ok("search_official_dom", new JsonObject { ["query"] = "TextFrame", ["limit"] = 3 });
        var first = ((JsonArray)found["matches"]!)[0]!;
        Assert.Equal("TextFrame", Json.Str(first, "name"));
        Assert.StartsWith("https://developer.adobe.com/indesign/dom/api/", Json.Str(first, "url"));
    }

    [Fact]
    public async Task Silent_status_reports_the_host()
    {
        using var sandbox = new Sandbox();
        var status = await sandbox.Ok("silent_status");
        Assert.True(Json.IsTrue(status, "available"));
        Assert.Equal("silent-com-uxp", Json.Str(status, "mode"));
        Assert.Equal(0, Json.Long(status["restoredMarkerRefresh"], "inspected"));
    }
}
