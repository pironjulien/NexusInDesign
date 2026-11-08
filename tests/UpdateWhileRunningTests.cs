using System.Diagnostics;
using System.Text.Json.Nodes;
using NexusInDesign.Security;

namespace NexusInDesign.Tests;

/// <summary>
/// An AI session keeps its MCP engine for hours while NexusSystem updates NexusInDesign. Up to 4.2.x the engine was a
/// self-contained single-file .NET program that read its own file again each time it loaded an assembly: until 4.2.1
/// get.ps1 renamed the running engine aside and put the new one at its path, and the open session's next calls failed
/// ("Internal error"). Since 4.2.2 each version lives in its own folder, never modified; since 4.3.0 the engine is
/// Native AOT, one native image that Windows maps, so even a file replaced under it no longer matters (NexusFree's
/// 1.3.4 single-file dispatcher still crashed after its replacement, on an assembly no preload had reached).
/// </summary>
public sealed class UpdateWhileRunningTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "nexusindesign-update", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>The engine only serves under a signed agent ancestor; here the signed dotnet.exe that runs the tests.</summary>
    private static string SignedAncestorFolder()
    {
        var dotnet = ParentProcessPolicy.ParentChain(Environment.ProcessId)
            .FirstOrDefault(process => string.Equals(Path.GetFileName(process.ExecutablePath), "dotnet.exe", StringComparison.OrdinalIgnoreCase));
        Assert.True(dotnet?.ExecutablePath is not null, "Run the tests through dotnet test (test.ps1): the engine needs a signed ancestor.");
        return Path.GetDirectoryName(dotnet!.ExecutablePath)!;
    }

    /// <summary>
    /// Antivirus or indexing services open a freshly written executable for a moment to scan it, without sharing
    /// delete: renaming it then fails with a sharing or lock violation while the engine itself holds nothing that
    /// forbids it. Only that external, transient hold is waited out, at most 10 s, as get.ps1 does for its staged folder.
    /// </summary>
    private static void MoveAsideOnceReleased(string path, string destination)
    {
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                File.Move(path, destination);
                return;
            }
            catch (IOException exception) when ((exception.HResult & 0xFFFF) is 32 or 33 && elapsed.Elapsed < TimeSpan.FromSeconds(10))
            {
                Thread.Sleep(100); // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
            }
        }
    }

    /// <summary>
    /// The release build (Native AOT, as tools/package.ps1 publishes it) is started, then its very file is replaced the
    /// way an installer replaces an exe in use: renamed aside, other bytes written at its path. Every later call, among
    /// them those that reach code and resources the session had not used yet, must still answer.
    /// </summary>
    [Fact]
    public async Task A_running_release_engine_keeps_answering_after_its_file_is_replaced()
    {
        string install = Directory.CreateDirectory(Path.Combine(root, "install")).FullName;
        string engine = Path.Combine(install, "NexusInDesign.exe");
        File.Copy(Packages.Engine, engine);

        string profile = Directory.CreateDirectory(Path.Combine(root, "profile-replaced")).FullName;
        var info = new ProcessStartInfo(engine, "--mcp")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.Environment["USERPROFILE"] = profile;
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_NAMES"] = "dotnet.exe";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_SIGNERS"] = "Microsoft Corporation";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_PATHS"] = SignedAncestorFolder();
        using var server = Process.Start(info)!;
        var errors = server.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        try
        {
            async Task<JsonObject> Call(int id, string method, JsonObject? parameters = null)
            {
                var request = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method };
                if (parameters is not null) request["params"] = parameters;
                await server.StandardInput.WriteLineAsync(request.ToJsonString());
                await server.StandardInput.FlushAsync();
                string? line = await server.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
                Assert.True(line is not null, "The engine ended: " + (server.HasExited ? await errors : ""));
                return Assert.IsType<JsonObject>(JsonNode.Parse(line));
            }

            async Task<string> Tool(int id, string name, JsonObject arguments, bool error = false)
            {
                var response = await Call(id, "tools/call", new JsonObject { ["name"] = name, ["arguments"] = arguments });
                Assert.True(response["error"] is null, name + ": " + response.ToJsonString());
                Assert.True(Json.IsTrue(response["result"], "isError") == error, name + ": " + response.ToJsonString());
                return response.ToJsonString();
            }

            Assert.NotNull((await Call(1, "initialize", new JsonObject { ["protocolVersion"] = "2025-11-25" }))["result"]);

            MoveAsideOnceReleased(engine, engine + ".old-test");
            var junk = new byte[4 * 1024 * 1024];
            Random.Shared.NextBytes(junk);
            await File.WriteAllBytesAsync(engine, junk, TestContext.Current.CancellationToken);

            // First uses after the replacement: the tool list (French or English texts), the embedded DOM index (XML),
            // the doctor's checks, and the JSON Schema validation of invalid arguments.
            Assert.NotNull((await Call(2, "tools/list"))["result"]?["tools"]);
            Assert.Contains("indesign-dom-paths.xml", await Tool(3, "search_official_dom", new JsonObject { ["query"] = "TextFrame", ["limit"] = 1 }), StringComparison.Ordinal);
            Assert.Contains(Program.Version, await Tool(4, "indesign_doctor", []), StringComparison.Ordinal);
            Assert.Contains("ARGUMENTS_INVALID", await Tool(5, "search_official_dom", new JsonObject { ["query"] = 5 }, error: true), StringComparison.Ordinal);
        }
        finally
        {
            server.StandardInput.Close();
            if (!server.WaitForExit(10_000)) server.Kill(entireProcessTree: true);
        }
    }

    [Fact]
    public async Task A_session_opened_before_an_update_keeps_answering()
    {
        string home = Path.Combine(root, "home");
        var (code, output) = Packages.Get("pwsh", Packages.Current, home);
        Assert.True(code == 0, output);
        string pointer = Path.Combine(home, "current.txt");
        string before = File.Exists(pointer) ? File.ReadAllText(pointer).Trim() : "";

        string profile = Directory.CreateDirectory(Path.Combine(root, "profile")).FullName;
        var info = new ProcessStartInfo(Path.Combine(home, "NexusInDesign.exe"), "--mcp")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.Environment["USERPROFILE"] = profile;
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_NAMES"] = "dotnet.exe";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_SIGNERS"] = "Microsoft Corporation";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_PATHS"] = SignedAncestorFolder();
        using var server = Process.Start(info)!;
        var errors = server.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        try
        {
            async Task<JsonObject> Call(int id, string method, JsonObject? parameters = null)
            {
                var request = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method };
                if (parameters is not null) request["params"] = parameters;
                await server.StandardInput.WriteLineAsync(request.ToJsonString());
                await server.StandardInput.FlushAsync();
                string? line = await server.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
                Assert.True(line is not null, "The engine ended: " + (server.HasExited ? await errors : ""));
                return Assert.IsType<JsonObject>(JsonNode.Parse(line));
            }

            async Task<JsonObject> Tool(int id, string name, JsonObject arguments)
            {
                var response = await Call(id, "tools/call", new JsonObject { ["name"] = name, ["arguments"] = arguments });
                Assert.True(response["error"] is null, name + ": " + response.ToJsonString());
                Assert.False(Json.IsTrue(response["result"], "isError"), name + ": " + response.ToJsonString());
                return (JsonObject)response["result"]!;
            }

            Assert.NotNull((await Call(1, "initialize", new JsonObject { ["protocolVersion"] = "2025-11-25" }))["result"]);

            // The update: another engine of the same version, installed while this session runs.
            (code, output) = Packages.Get("pwsh", Packages.Rebuilt, home);
            Assert.True(code == 0, output);

            // Calls that load assemblies the session had not needed yet (the DOM index's XML, the doctor's checks).
            Assert.NotNull((await Call(2, "tools/list"))["result"]?["tools"]);
            Assert.Contains("indesign-dom-paths.xml", (await Tool(3, "search_official_dom", new JsonObject { ["query"] = "TextFrame", ["limit"] = 1 })).ToJsonString(), StringComparison.Ordinal);
            Assert.Contains(Program.Version, (await Tool(4, "indesign_doctor", [])).ToJsonString(), StringComparison.Ordinal);

            // New sessions get the new engine; the running one's folder stays.
            Assert.NotEqual(before, File.ReadAllText(pointer).Trim());
            Assert.True(File.Exists(Path.Combine(home, "versions", before, "NexusInDesign.exe")), "the running engine's folder must stay");
        }
        finally
        {
            server.StandardInput.Close();
            if (!server.WaitForExit(10_000)) server.Kill(entireProcessTree: true);
        }

        // Once the session has ended, the next run removes the older version.
        await Task.Delay(500, TestContext.Current.CancellationToken);
        (code, output) = Packages.Get("pwsh", Packages.Rebuilt, home);
        Assert.True(code == 0, output);
        Assert.False(Directory.Exists(Path.Combine(home, "versions", before)));
    }
}
