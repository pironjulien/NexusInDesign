using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NexusInDesign;

/// <summary>
/// MCP over stdio (JSON-RPC, one message per line): initialize, ping, tools/list and tools/call. Tool calls run
/// concurrently with the reading loop (pings stay answered); InDesign commands themselves are queued by Application.
/// </summary>
internal sealed class McpServer(Application application)
{
    private static readonly string[] Protocols = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
    private readonly object writeLock = new();
    private TextWriter? output;

    public async Task RunStdio(TextReader input, TextWriter writer, CancellationToken cancellation = default)
    {
        output = writer;
        var running = new List<Task>();
        while (!cancellation.IsCancellationRequested && await input.ReadLineAsync(cancellation).ConfigureAwait(false) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonObject? request;
            try { request = JsonNode.Parse(line) as JsonObject; }
            catch (JsonException) { request = null; }
            if (request is null)
            {
                Write(Error(null, -32700, "Invalid JSON request"));
                continue;
            }
            running.RemoveAll(task => task.IsCompleted);
            running.Add(Task.Run(async () =>
            {
                JsonObject? response;
                try { response = await Handle(request).ConfigureAwait(false); }
                catch (Exception) { response = request.ContainsKey("id") ? Error(request["id"], -32603, "Internal error") : null; }
                if (response is not null) Write(response);
            }, CancellationToken.None));
        }
        await Task.WhenAll(running).ConfigureAwait(false);
    }

    private void Write(JsonObject message)
    {
        lock (writeLock)
        {
            output!.WriteLine(message.ToJsonString(Json.Compact));
            output.Flush();
        }
    }

    private static JsonObject Error(JsonNode? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0", ["id"] = id?.DeepClone(), ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    private static JsonObject Result(JsonNode? id, JsonObject result) => new() { ["jsonrpc"] = "2.0", ["id"] = id?.DeepClone(), ["result"] = result };

    internal async Task<JsonObject?> Handle(JsonObject request)
    {
        string? method = Json.Str(request, "method");
        var id = request["id"];
        if (method is null) return request.ContainsKey("id") ? Error(id, -32600, "Method required") : null;
        if (!request.ContainsKey("id")) return null; // notifications (initialized, cancelled) need no answer
        switch (method)
        {
            case "initialize":
            {
                string requested = Json.Str(request["params"], "protocolVersion") ?? "";
                return Result(id, new JsonObject
                {
                    ["protocolVersion"] = Protocols.Contains(requested) ? requested : Protocols[^1],
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject { ["name"] = "nexus-indesign", ["version"] = Program.Version },
                    ["instructions"] = Strings.Instructions,
                });
            }
            case "ping":
                return Result(id, []);
            case "tools/list":
                return Result(id, new JsonObject { ["tools"] = application.Catalog.PublicList(Strings.French) });
            case "tools/call":
            {
                var parameters = request["params"] as JsonObject;
                string name = Json.Str(parameters, "name") ?? "";
                if (application.Catalog.Find(name) is null) return Error(id, -32602, $"Unknown tool: {name}");
                if (parameters?["arguments"] is not null and not JsonObject) return Error(id, -32602, "arguments must be an object");
                var arguments = parameters?["arguments"] as JsonObject ?? [];
                return Result(id, await application.CallTool(name, arguments).ConfigureAwait(false));
            }
            default:
                return Error(id, -32601, "Method not found");
        }
    }
}
