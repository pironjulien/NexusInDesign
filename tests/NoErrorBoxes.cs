using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace NexusInDesign.Tests;

/// <summary>
/// No test may ever show a Windows error box: a process started on a file that is not a valid image (the "16-bit
/// application not supported" box), a missing DLL or drive, a crash. Set when the test assembly loads; every process
/// a test starts inherits the error mode (no CREATE_DEFAULT_ERROR_MODE), and so do theirs.
/// The runtime does not keep it: coreclr loads each native library between SetErrorMode(SEM_FAILCRITICALERRORS |
/// SEM_NOOPENFILEERRORBOX) and a restore of the previous mode, so two libraries loaded at once by parallel tests can
/// leave the process without SEM_NOGPFAULTERRORBOX for good (seen in the Release run of 6063fed: 0x8001). Every test
/// therefore starts its processes through <see cref="Start"/>, which sets the mode again right before CreateProcess.
/// </summary>
internal static class NoErrorBoxes
{
    internal const uint Mode = 0x0001 /* SEM_FAILCRITICALERRORS */ | 0x0002 /* SEM_NOGPFAULTERRORBOX */ | 0x8000 /* SEM_NOOPENFILEERRORBOX */;
    private static readonly Lock Starting = new();

#pragma warning disable CA2255 // A module initializer is the only hook that runs before every test and every process a test starts.
    [ModuleInitializer]
#pragma warning restore CA2255
    internal static void Set() => _ = SetErrorMode(GetErrorMode() | Mode);

    /// <summary>Process.Start with the error mode set again first, so the child inherits it.</summary>
    internal static Process Start(ProcessStartInfo info)
    {
        lock (Starting)
        {
            Set();
            return Process.Start(info) ?? throw new InvalidOperationException($"{info.FileName} did not start.");
        }
    }

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    internal static extern uint SetErrorMode(uint mode);

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    internal static extern uint GetErrorMode();
}

public sealed class NoErrorBoxesTests
{
    [Fact]
    public async Task ProcessesStartedByTestsInheritTheNoErrorBoxMode()
    {
        // What coreclr's racing native library loads leave behind: the mode without SEM_NOGPFAULTERRORBOX.
        _ = NoErrorBoxes.SetErrorMode(NoErrorBoxes.GetErrorMode() & ~0x0002u);
        var start = new ProcessStartInfo("pwsh.exe")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string arg in new[] { "-NoProfile", "-NonInteractive", "-Command",
                     "Add-Type -Namespace NoErrorBoxesTest -Name ErrorMode -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint GetErrorMode();'; [NoErrorBoxesTest.ErrorMode]::GetErrorMode()" })
            start.ArgumentList.Add(arg);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(120));
        using var child = NoErrorBoxes.Start(start);
        try
        {
            var error = child.StandardError.ReadToEndAsync(timeout.Token);
            string output = await child.StandardOutput.ReadToEndAsync(timeout.Token);
            await child.WaitForExitAsync(timeout.Token);
            Assert.True(child.ExitCode == 0, await error + output);
            Assert.Equal(NoErrorBoxes.Mode, uint.Parse(output.Trim(), CultureInfo.InvariantCulture) & NoErrorBoxes.Mode);
        }
        finally
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
        }
    }
}
