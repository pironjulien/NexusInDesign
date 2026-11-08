using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;

namespace NexusInDesign.Tests;

/// <summary>
/// Packages like a release's, built once per test run: the engine and the launcher published as in tools/package.ps1
/// (both Native AOT), zipped together; and get.ps1 run on such a package.
/// </summary>
internal static class Packages
{
    private static readonly string Work = Path.Combine(Path.GetTempPath(), "nexusindesign-get", "package-" + Guid.NewGuid().ToString("N"));
    private static readonly string Rid = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";

    private static void Publish(string project, string output, params string[] properties)
    {
        var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in new[] { "publish", project, "-c", "Release", "-r", Rid, "-p:DebugType=none",
            $"-p:NexusBuild={output}-build{Path.DirectorySeparatorChar}", "-o", output, "-v", "q" }.Concat(properties))
            info.ArgumentList.Add(argument);
        // Native AOT links with the Visual C++ tools, which it finds through vswhere.exe.
        string vswhere = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft Visual Studio", "Installer");
        info.Environment["PATH"] = Environment.GetEnvironmentVariable("PATH") + Path.PathSeparator + vswhere;
        using var process = NoErrorBoxes.Start(info);
        var stdout = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(900_000) || process.ExitCode != 0) throw new InvalidOperationException($"dotnet publish {Path.GetFileName(project)} failed: " + stdout.Result + error.Result);
    }

    private static readonly Lazy<(string Engine, string Launcher)> Built = new(() =>
    {
        string engine = Path.Combine(Work, "engine");
        string launcher = Path.Combine(Work, "launcher");
        Publish(Repository.File("native", "NexusInDesign.csproj"), engine);
        // Native AOT: one native image, nothing beside it to load later.
        Assert.Equal(["NexusInDesign.exe"], Directory.GetFiles(engine).Select(Path.GetFileName));
        Publish(Repository.File("launcher", "NexusInDesignLauncher.csproj"), launcher);
        return (Path.Combine(engine, "NexusInDesign.exe"), Path.Combine(launcher, "NexusInDesignLauncher.exe"));
    });

    private static string Zip(string name, string engine)
    {
        string folder = Directory.CreateDirectory(Path.Combine(Work, name)).FullName;
        string zip = Path.Combine(folder, $"NexusInDesign-{Rid}.zip");
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            archive.CreateEntryFromFile(engine, "NexusInDesign.exe");
            archive.CreateEntryFromFile(Built.Value.Launcher, "NexusInDesignLauncher.exe");
        }
        return zip;
    }

    private static readonly Lazy<string> current = new(() => Zip("current", Built.Value.Engine));

    // The same version built another way (optimized for size): another engine file whose code sits at other offsets,
    // as in any new build. A session that read it in place of its own would run garbage.
    private static readonly Lazy<string> rebuilt = new(() =>
    {
        string engine = Path.Combine(Work, "engine-size");
        Publish(Repository.File("native", "NexusInDesign.csproj"), engine, "-p:OptimizationPreference=Size");
        return Zip("rebuilt", Path.Combine(engine, "NexusInDesign.exe"));
    });

    /// <summary>The engine of the release build (Native AOT), as tools/package.ps1 publishes it.</summary>
    public static string Engine => Built.Value.Engine;

    /// <summary>The package of this version.</summary>
    public static string Current => current.Value;

    /// <summary>Another package of this version, with another engine file.</summary>
    public static string Rebuilt => rebuilt.Value;

    public static (int Code, string Output) Get(string shell, string zip, string home, params string[] args)
    {
        var info = new ProcessStartInfo(shell) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        foreach (string argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", Repository.File("get.ps1") }.Concat(args)) info.ArgumentList.Add(argument);
        info.Environment["NEXUS_INDESIGN_SOURCE"] = zip;
        info.Environment["NEXUS_INDESIGN_HOME"] = home;
        info.Environment["NEXUS_PACK"] = "1";
        info.Environment.Remove("NEXUS_RELEASE_TAG");
        using var process = NoErrorBoxes.Start(info);
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(120_000), "get.ps1 did not finish");
        return (process.ExitCode, output.Result + error.Result);
    }
}
