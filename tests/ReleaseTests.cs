using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Tests;

/// <summary>One version everywhere, plugins that start the installed engine, and get.ps1 on a local package.</summary>
public sealed class ReleaseTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "nexusindesign-get", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static JsonObject ReadJson(params string[] parts) => (JsonObject)JsonNode.Parse(File.ReadAllText(Repository.File(parts)))!;

    [Fact]
    public void Every_file_carries_the_engine_version()
    {
        string version = Program.Version;
        Assert.Matches(@"^\d+\.\d+\.\d+$", version);
        Assert.Contains($"<Version>{version}</Version>", File.ReadAllText(Repository.File("native", "NexusInDesign.csproj")));
        Assert.Equal(version, Json.Str(ReadJson("plugin", ".claude-plugin", "plugin.json"), "version"));
        Assert.Equal(version, Json.Str(ReadJson("plugin", ".codex-plugin", "plugin.json"), "version"));
        var server = ReadJson("server.json");
        Assert.Equal(version, Json.Str(server, "version"));
        foreach (string arch in new[] { "x64", "arm64" })
            Assert.Contains(((JsonArray)server["packages"]!).OfType<JsonObject>(), package =>
                Json.Str(package, "identifier") == $"https://github.com/pironjulien/NexusInDesign/releases/download/v{version}/nexus-indesign-{version}-win-{arch}.mcpb");
        Assert.Equal(version, Regex.Match(File.ReadAllText(Repository.File("CHANGELOG.md")), @"(?m)^## \[(\d+\.\d+\.\d+)\]").Groups[1].Value);
    }

    [Fact]
    public void Plugins_start_the_installed_engine_without_Node_or_a_panel()
    {
        var claude = ReadJson("plugin", ".mcp.json")["mcpServers"]!["nexus-indesign"]!;
        Assert.Equal(@"${USERPROFILE}\.nexus\nexus-indesign\NexusInDesign.exe", Json.Str(claude, "command"));
        Assert.Equal("--mcp", claude["args"]![0]!.GetValue<string>());
        var codex = ReadJson("plugin", ".codex-mcp.json")["mcpServers"]!["nexus-indesign"]!;
        Assert.Contains(@"%USERPROFILE%\.nexus\nexus-indesign", codex["args"]!.ToJsonString().Replace(@"\\", @"\"));
        Assert.Equal("./.codex-mcp.json", Json.Str(ReadJson("plugin", ".codex-plugin", "plugin.json"), "mcpServers"));
        Assert.True(File.Exists(Repository.File("plugin", "skills", "indesign-studio", "SKILL.md")));
        foreach (string file in Directory.EnumerateFiles(Repository.File("plugin"), "*", SearchOption.AllDirectories).Where(file => file.EndsWith(".json") || file.EndsWith(".md")))
            Assert.DoesNotMatch(@"\bnode(\.exe)?\b|\.ccx|bridge_open_pairing|INDESIGN_MCP_TOKEN_FILE", File.ReadAllText(file));
    }

    [Fact]
    public void The_skill_names_only_existing_tools()
    {
        var tools = ToolCatalog.Shared.Tools.Select(tool => tool.Name).ToHashSet();
        string skill = string.Concat(Directory.EnumerateFiles(Repository.File("plugin", "skills"), "*.md", SearchOption.AllDirectories).Select(File.ReadAllText));
        foreach (Match match in Regex.Matches(skill, @"`((?:silent|run|execute|export|get|list|open|create|save|preflight|finalize|preview|analyze|compare|package|search|indesign)_[a-z_]+)`"))
            Assert.Contains(match.Groups[1].Value, tools);
    }

    [Fact]
    public void Scripts_never_run_downloaded_code_in_memory()
    {
        var forbidden = new Regex(@"\birm\b|\biex\b|Invoke-Expression|scriptblock\]::Create|EncodedCommand", RegexOptions.IgnoreCase);
        foreach (string file in new[] { "get.ps1", "test.ps1", Path.Combine("tools", "package.ps1"), "README.md" })
            Assert.DoesNotMatch(forbidden, File.ReadAllText(Repository.File(file)));
    }

    private (int Code, string Output) Get(string shell, string zip, string home, params string[] args)
    {
        var info = new ProcessStartInfo(shell) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        foreach (string argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", Repository.File("get.ps1") }.Concat(args)) info.ArgumentList.Add(argument);
        info.Environment["NEXUS_INDESIGN_SOURCE"] = zip;
        info.Environment["NEXUS_INDESIGN_HOME"] = home;
        info.Environment["NEXUS_PACK"] = "1";
        info.Environment.Remove("NEXUS_RELEASE_TAG");
        using var process = Process.Start(info)!;
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(120_000), "get.ps1 did not finish");
        return (process.ExitCode, output.Result + error.Result);
    }

    [Theory]
    [InlineData("pwsh")]
    [InlineData("powershell")]
    public void Get_installs_updates_and_removes_from_a_local_package(string shell)
    {
        Directory.CreateDirectory(root);
        string zip = Path.Combine(root, "NexusInDesign-win-x64.zip");
        // The engine the tests run, with what it needs next to it (framework-dependent here, self-contained in a release).
        string engine = Path.GetDirectoryName(typeof(Program).Assembly.Location)!;
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
            foreach (string file in Directory.GetFiles(engine).Where(file => !Path.GetFileName(file).StartsWith("NexusInDesign.Tests", StringComparison.OrdinalIgnoreCase)))
                archive.CreateEntryFromFile(file, Path.GetFileName(file));
        string home = Path.Combine(root, "home");
        var (code, output) = Get(shell, zip, home);
        Assert.True(code == 0, output);
        Assert.Equal($"NEXUS_PACK_RESULT NexusInDesign=installed {Program.Version}", output.Trim().Split('\n')[^1].Trim());
        Assert.True(File.Exists(Path.Combine(home, "NexusInDesign.exe")));
        (code, output) = Get(shell, zip, home);
        Assert.True(code == 0, output);
        Assert.Single(Directory.GetFiles(home, "NexusInDesign.exe*"));
        (code, output) = Get(shell, zip, home, "-Remove");
        Assert.True(code == 0, output);
        Assert.False(File.Exists(Path.Combine(home, "NexusInDesign.exe")));
    }
}
