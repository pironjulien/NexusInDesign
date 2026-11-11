using System.Diagnostics;
using System.Text.Json.Nodes;
using NexusInDesign.Launcher;
using NexusInDesign.Security;

namespace NexusInDesign.Tests;

/// <summary>
/// get.ps1 keeps the folder of an engine a session runs while it installs, and nothing removed it afterwards until the
/// next version (4.2.2 and 4.2.3 left beside 4.3.0, 74 MB each). The launcher now removes what is left at each session
/// start (<see cref="Leftovers"/>). Always on a fake install folder, never the real one.
/// </summary>
public sealed class LeftoversTests : IDisposable
{
    private const string Current = "4.3.1-0123456789abcdef", Older = "4.2.2-fedcba9876543210", Old = "4.2.3-00112233445566aa";
    private static readonly DateTime Now = DateTime.UtcNow;
    private readonly string home = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "nexusindesign-leftovers", Guid.NewGuid().ToString("N"))).FullName;
    private readonly List<Process> processes = [];

    public void Dispose()
    {
        foreach (var process in processes)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); process.WaitForExit(10_000); } catch (InvalidOperationException) { }
            process.Dispose();
        }
        try { Directory.Delete(home, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private string Versions => Path.Combine(home, "versions");

    /// <summary>A version folder holding an engine (a copy of PING.EXE, a real image that can be started), created an hour ago.</summary>
    private string Version(string name, bool fresh = false)
    {
        string folder = Directory.CreateDirectory(Path.Combine(Versions, name)).FullName;
        File.Copy(Path.Combine(Environment.SystemDirectory, "PING.EXE"), Path.Combine(folder, "NexusInDesign.exe"));
        if (!fresh) Directory.SetCreationTimeUtc(folder, Now - TimeSpan.FromHours(1));
        return folder;
    }

    private void Point(string? name)
    {
        if (name is not null) File.WriteAllText(Path.Combine(home, "current.txt"), name);
    }

    private string OldLauncher(string id)
    {
        string path = Path.Combine(home, "NexusInDesign.exe.old-" + id);
        File.Copy(Path.Combine(Environment.SystemDirectory, "PING.EXE"), path);
        return path;
    }

    /// <summary>Runs an image the way a session runs its engine, for a minute at most.</summary>
    private void Run(string image)
    {
        var info = new ProcessStartInfo(image) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        foreach (string argument in new[] { "-n", "60", "127.0.0.1" }) info.ArgumentList.Add(argument);
        var process = Process.Start(info)!;
        processes.Add(process);
        _ = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
    }

    private string[] Folders() => Directory.GetDirectories(Versions).Select(path => Path.GetFileName(path)!).Order(StringComparer.Ordinal).ToArray();

    [Fact]
    public void Older_versions_and_free_launchers_go_and_the_current_version_stays()
    {
        Version(Current);
        Version(Older);
        Version(Old);
        Point(Current);
        OldLauncher("a");
        OldLauncher("b");
        // Not a version folder: an installation's staged copy, never touched here.
        Directory.CreateDirectory(Path.Combine(Versions, ".new-0123"));

        var removed = Leftovers.Remove(home, Now);

        Assert.Equal([Older, Old], removed.Order(StringComparer.Ordinal));
        Assert.Equal([".new-0123", Current], Folders());
        Assert.True(File.Exists(Path.Combine(Versions, Current, "NexusInDesign.exe")));
        Assert.Empty(Directory.GetFiles(home, "NexusInDesign.exe.old-*"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  \r\n")]
    [InlineData("4.3.1-9999999999999999")] // a version folder that does not exist
    [InlineData("..\\..")]
    public void Nothing_is_removed_unless_current_txt_names_an_installed_version(string? content)
    {
        Version(Older);
        Version(Old);
        Point(content);
        string launcher = OldLauncher("a");

        Assert.Empty(Leftovers.Remove(home, Now));

        Assert.Equal([Older, Old], Folders());
        Assert.True(File.Exists(launcher));
    }

    [Fact]
    public void A_version_whose_engine_a_session_runs_stays_whole_until_it_ends()
    {
        Version(Current);
        string running = Version(Old);
        Point(Current);
        string launcher = OldLauncher("running");
        Run(Path.Combine(running, "NexusInDesign.exe"));
        Run(launcher);

        // Windows would let the folder be renamed under the running engine: it must not be.
        Assert.Empty(Leftovers.Remove(home, Now));
        Assert.Equal([Old, Current], Folders());
        Assert.True(File.Exists(Path.Combine(running, "NexusInDesign.exe")));
        Assert.True(File.Exists(launcher));

        foreach (var process in processes)
        {
            process.Kill();
            Assert.True(process.WaitForExit(10_000));
        }
        Assert.Equal([Old], Leftovers.Remove(home, Now));
        Assert.Equal([Current], Folders());
        Assert.False(File.Exists(launcher));
    }

    [Fact]
    public void A_version_just_installed_stays_for_the_grace_period()
    {
        Version(Current);
        Version(Old, fresh: true);
        Point(Current);

        Assert.Empty(Leftovers.Remove(home, DateTime.UtcNow));
        Assert.Equal([Old, Current], Folders());

        Assert.Equal([Old], Leftovers.Remove(home, DateTime.UtcNow + Leftovers.Grace + TimeSpan.FromMinutes(1)));
        Assert.Equal([Current], Folders());
    }

    [Fact]
    public void A_removal_interrupted_halfway_is_finished_and_a_trash_still_running_waits()
    {
        Version(Current);
        Point(Current);
        // What an interrupted removal leaves: the folder already renamed, part of its contents deleted or not.
        string left = Version(".trash-0001");
        File.WriteAllText(Path.Combine(left, "other.txt"), "x");
        string busy = Version(".trash-0002");
        Run(Path.Combine(busy, "NexusInDesign.exe"));

        Assert.Empty(Leftovers.Remove(home, Now));

        Assert.Equal([".trash-0002", Current], Folders());
        Assert.True(File.Exists(Path.Combine(busy, "NexusInDesign.exe")));
    }

    [Fact]
    public void The_check_of_a_folder_costs_little()
    {
        Version(Current);
        Point(Current);
        OldLauncher("running");
        Run(Path.Combine(home, "NexusInDesign.exe.old-running"));
        Leftovers.Remove(home, Now);
        var elapsed = Stopwatch.StartNew();
        for (int i = 0; i < 100; i++) Leftovers.Remove(home, Now);
        // Measured about 0.2 ms per pass on a desktop PC; generous bound for a loaded CI runner.
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(2), $"100 passes took {elapsed.Elapsed.TotalMilliseconds} ms");
    }

    [Fact]
    public async Task The_installed_launcher_removes_an_older_version_when_a_session_starts()
    {
        var (code, output) = Packages.Get("pwsh", Packages.Current, home);
        Assert.True(code == 0, output);
        string current = File.ReadAllText(Path.Combine(home, "current.txt")).Trim();
        string older = Version(Older);
        string launcher = OldLauncher("ended");
        string stable = Path.Combine(home, "NexusInDesign.exe");

        // get.ps1 checks the launcher with --version while it installs: no removal then.
        var check = Process.Start(new ProcessStartInfo(stable, "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true })!;
        processes.Add(check);
        Assert.Contains(Program.Version, await check.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken), StringComparison.Ordinal);
        Assert.True(check.WaitForExit(30_000));
        Assert.True(Directory.Exists(older));

        string profile = Directory.CreateDirectory(Path.Combine(home, "profile")).FullName;
        var info = new ProcessStartInfo(stable, "--mcp")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.Environment["USERPROFILE"] = profile;
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_NAMES"] = "dotnet.exe";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_SIGNERS"] = "Microsoft Corporation";
        info.Environment["INDESIGN_MCP_ALLOWED_PARENT_PATHS"] = SignedAncestorFolder();
        var server = Process.Start(info)!;
        processes.Add(server);
        _ = server.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);

        var waited = Stopwatch.StartNew();
        while ((Directory.Exists(older) || File.Exists(launcher)) && waited.Elapsed < TimeSpan.FromSeconds(30))
            await Task.Delay(100, TestContext.Current.CancellationToken);
        Assert.False(Directory.Exists(older), "the older version must be removed once the session has started");
        Assert.False(File.Exists(launcher));
        Assert.Equal([current], Folders());

        // The session itself is not disturbed.
        await server.StandardInput.WriteLineAsync(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "initialize", ["params"] = new JsonObject { ["protocolVersion"] = "2025-11-25" } }.ToJsonString().AsMemory(), TestContext.Current.CancellationToken);
        await server.StandardInput.FlushAsync(TestContext.Current.CancellationToken);
        string? line = await server.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
        Assert.NotNull(JsonNode.Parse(line ?? "{}")?["result"]);
        server.StandardInput.Close();
        Assert.True(server.WaitForExit(10_000));
    }

    private static string SignedAncestorFolder()
    {
        var dotnet = ParentProcessPolicy.ParentChain(Environment.ProcessId)
            .FirstOrDefault(process => string.Equals(Path.GetFileName(process.ExecutablePath), "dotnet.exe", StringComparison.OrdinalIgnoreCase));
        Assert.True(dotnet?.ExecutablePath is not null, "Run the tests through dotnet test (test.ps1): the engine needs a signed ancestor.");
        return Path.GetDirectoryName(dotnet!.ExecutablePath)!;
    }
}
