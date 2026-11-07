using System.Diagnostics;
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
    public void Changelog_links_every_version_and_compares_unreleased_from_the_latest()
    {
        string text = File.ReadAllText(Repository.File("CHANGELOG.md"));
        var versions = Regex.Matches(text, @"(?m)^## \[(\d+\.\d+\.\d+)\]").Select(match => match.Groups[1].Value).ToList();
        Assert.NotEmpty(versions);
        Assert.Matches($@"(?m)^\[Unreleased\]: https://github\.com/pironjulien/NexusInDesign/compare/v{Regex.Escape(versions[0])}\.\.\.HEAD\r?$", text);
        // The first published release links to its tag; the sections before it were never tagged.
        int first = versions.FindIndex(version => Regex.IsMatch(text, $@"(?m)^\[{Regex.Escape(version)}\]: https://github\.com/pironjulien/NexusInDesign/releases/tag/v{Regex.Escape(version)}\r?$"));
        Assert.True(first >= 0, "The first published release must link to its tag.");
        for (int i = 0; i < first; i++)
        {
            string target = Regex.Escape(versions[i]);
            Assert.Matches($@"(?m)^\[{target}\]: https://github\.com/pironjulien/NexusInDesign/compare/v{Regex.Escape(versions[i + 1])}\.\.\.v{target}\r?$", text);
        }
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
        Assert.True(File.Exists(Repository.File("plugin", "skills", "nexus-indesign", "SKILL.md")));
        foreach (string file in Directory.EnumerateFiles(Repository.File("plugin"), "*", SearchOption.AllDirectories).Where(file => file.EndsWith(".json", StringComparison.Ordinal) || file.EndsWith(".md", StringComparison.Ordinal)))
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

    private static (int Code, string Output) Get(string shell, string zip, string home, params string[] args) => Packages.Get(shell, zip, home, args);

    [Theory]
    [InlineData("pwsh")]
    [InlineData("powershell")]
    public void Get_installs_updates_and_removes_from_a_local_package(string shell)
    {
        string home = Path.Combine(root, "home");
        var (code, output) = Get(shell, Packages.Current, home);
        Assert.True(code == 0, output);
        Assert.Equal($"NEXUS_PACK_RESULT NexusInDesign=installed {Program.Version}", output.Trim().Split('\n')[^1].Trim());
        // The launcher the plugins start, the pointer, and the engine in a folder of its own.
        Assert.True(File.Exists(Path.Combine(home, "NexusInDesign.exe")));
        string name = File.ReadAllText(Path.Combine(home, "current.txt")).Trim();
        Assert.Matches($@"^{Regex.Escape(Program.Version)}-[0-9a-f]{{16}}$", name);
        Assert.True(File.Exists(Path.Combine(home, "versions", name, "NexusInDesign.exe")));
        (code, output) = Get(shell, Packages.Current, home);
        Assert.True(code == 0, output);
        Assert.Single(Directory.GetFiles(home, "NexusInDesign.exe*"));
        Assert.Equal([name], Directory.GetDirectories(Path.Combine(home, "versions")).Select(Path.GetFileName));
        (code, output) = Get(shell, Packages.Current, home, "-Remove");
        Assert.True(code == 0, output);
        Assert.False(File.Exists(Path.Combine(home, "NexusInDesign.exe")));
        Assert.False(File.Exists(Path.Combine(home, "current.txt")));
        Assert.False(Directory.Exists(Path.Combine(home, "versions")));
    }

    [Theory]
    [InlineData("pwsh", false)]
    [InlineData("powershell", false)]
    [InlineData("pwsh", true)]
    [InlineData("powershell", true)]
    public void A_scanner_briefly_holding_the_fresh_copy_does_not_fail_the_installation(string shell, bool update)
    {
        // What an antivirus does to a freshly written executable: opens it for a moment. Without delete sharing that
        // blocks renaming its staged folder into place (versions\.new-<id> to versions\<version>-<hash>); get.ps1
        // waits that hold out instead of failing ("being used by another process", seen once with NexusAGYmail in
        // NexusSystem's pack job on a fresh Windows runner). Here the staged folder itself is held, from its creation
        // (before the engine is even copied into it), so the hold always overlaps the rename. An update writes another
        // engine: the rebuilt package.
        string zip = update ? Packages.Rebuilt : Packages.Current;
        string home = Path.Combine(root, "home");
        if (update)
        {
            var first = Get(shell, Packages.Current, home);
            Assert.True(first.Code == 0, first.Output);
        }
        string versions = Directory.CreateDirectory(Path.Combine(home, "versions")).FullName;

        string? held = null;
        bool stagedWhileHeld = false;
        using var released = new ManualResetEventSlim();
        using var watcher = new FileSystemWatcher(versions, ".new-*") { NotifyFilter = NotifyFilters.DirectoryName };
        var scanner = new Thread(() =>
        {
            string path = watcher.WaitForChanged(WatcherChangeTypes.Created, 60_000) is { TimedOut: false } change ? Path.Combine(versions, change.Name!) : "";
            var deadline = Stopwatch.StartNew();
            while (held is null && path.Length > 0 && deadline.Elapsed < TimeSpan.FromSeconds(20) && Directory.Exists(path))
            {
                using var scan = Native.OpenFolder(path);
                if (scan.IsInvalid) { Thread.Yield(); continue; }
                held = path;
                Thread.Sleep(2_000);
                stagedWhileHeld = Directory.Exists(path);
            }
            released.Set();
        }) { IsBackground = true };
        watcher.EnableRaisingEvents = true;
        scanner.Start();
        var (code, output) = Get(shell, zip, home);
        Assert.True(released.Wait(60_000, TestContext.Current.CancellationToken));
        Assert.True(code == 0, output);
        Assert.NotNull(held);
        Assert.True(stagedWhileHeld, "the hold must have overlapped the staged copy");
        string stable = Path.Combine(home, "NexusInDesign.exe");
        Assert.Equal(Program.Version, FileVersionInfo.GetVersionInfo(stable).ProductVersion!.Split('+')[0]);
        Assert.Empty(Directory.GetFiles(home, "NexusInDesign.exe.new-*"));
        Assert.Empty(Directory.GetDirectories(Path.Combine(home, "versions"), ".new-*"));
        Assert.Single(Directory.GetDirectories(Path.Combine(home, "versions")));
    }
}
