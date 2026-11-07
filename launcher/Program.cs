using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace NexusInDesign.Launcher;

/// <summary>
/// The program the plugins start (~\.nexus\nexus-indesign\NexusInDesign.exe). It runs the engine named by current.txt
/// (versions\&lt;version&gt;-&lt;hash&gt;\NexusInDesign.exe) with the same arguments and standard streams, waits for it and
/// returns its exit code. The engine is a self-contained single-file .NET program that reads its own file again each
/// time it loads an assembly: an update that replaced that file under a running session broke every later call of
/// that session. get.ps1 now writes each version to a folder of its own, never modified afterwards, switches
/// current.txt to it, and removes an older folder only once no process runs its engine any more. The engine exits when
/// this launcher ends (its parent watchdog).
/// </summary>
internal static partial class Program
{
    internal const string Pointer = "current.txt";

    private static int Main(string[] args)
    {
        string home = AppContext.BaseDirectory;
        for (int attempt = 1; ; attempt++)
        {
            string? engine = Engine(home);
            if (engine is null)
            {
                Console.Error.WriteLine("[nexus-indesign] No engine installed next to this launcher: run NexusSystem or NexusInDesign's get.ps1 again.");
                return 1;
            }
            try
            {
                return Run(engine, args);
            }
            catch (Win32Exception) when (attempt == 1 && !File.Exists(engine))
            {
                // An update switched current.txt and removed the unused older engine between the read and the start:
                // read the pointer again.
            }
        }
    }

    /// <summary>The engine current.txt names, or null when it names none that exists.</summary>
    internal static string? Engine(string home)
    {
        string name = "";
        for (int attempt = 1; attempt <= 20; attempt++)
        {
            try
            {
                name = File.ReadAllText(Path.Combine(home, Pointer)).Trim();
                break;
            }
            catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException) { return null; }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // get.ps1 replacing current.txt at this very moment, or a scanner holding it: a short wait.
                if (attempt == 20) return null;
                Thread.Sleep(50);
            }
        }
        if (!IsVersionFolder(name)) return null;
        string engine = Path.Combine(home, "versions", name, "NexusInDesign.exe");
        return File.Exists(engine) ? engine : null;
    }

    /// <summary>A folder name of the form 1.2.3-0123456789abcdef (version and start of the engine's SHA-256).</summary>
    internal static bool IsVersionFolder(string name)
    {
        int dash = name.IndexOf('-', StringComparison.Ordinal);
        if (dash <= 0 || name.Length - dash - 1 != 16) return false;
        string[] parts = name[..dash].Split('.');
        return parts.Length == 3 && parts.All(part => part.Length > 0 && part.All(char.IsAsciiDigit)) &&
            name[(dash + 1)..].All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');
    }

    /// <summary>One argument as CommandLineToArgvW reads it back.</summary>
    internal static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0) return argument;
        var quoted = new StringBuilder("\"");
        for (int i = 0; i < argument.Length; i++)
        {
            int backslashes = 0;
            while (i < argument.Length && argument[i] == '\\') { backslashes++; i++; }
            if (i == argument.Length) { quoted.Append('\\', backslashes * 2); break; }
            if (argument[i] == '"') quoted.Append('\\', backslashes * 2 + 1).Append('"');
            else quoted.Append('\\', backslashes).Append(argument[i]);
        }
        return quoted.Append('"').ToString();
    }

    /// <summary>
    /// Starts the engine on this process's own standard handles (the MCP pipes of Claude Code or Codex, or a console),
    /// without a console window of its own, then waits for it.
    /// </summary>
    private static unsafe int Run(string engine, string[] args)
    {
        nint[] handles = [GetStdHandle(StdInput), GetStdHandle(StdOutput), GetStdHandle(StdError)];
        foreach (nint handle in handles)
            if (handle is not 0 and not -1) SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit);
        var startup = new StartupInfo
        {
            Size = sizeof(StartupInfo), Flags = UseStdHandles, StdInput = handles[0], StdOutput = handles[1], StdError = handles[2],
        };
        string commandLine = string.Join(' ', new[] { Quote(engine) }.Concat(args.Select(Quote))) + '\0';
        char[] buffer = commandLine.ToCharArray();
        ProcessInformation process;
        fixed (char* application = engine)
        fixed (char* command = buffer)
        {
            if (!CreateProcessW(application, command, 0, 0, 1, CreateNoWindow, 0, null, &startup, &process))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        try
        {
            CloseHandle(process.Thread);
            WaitForSingleObject(process.Process, Infinite);
            return GetExitCodeProcess(process.Process, out uint code) ? unchecked((int)code) : 1;
        }
        finally
        {
            CloseHandle(process.Process);
        }
    }

    private const int StdInput = -10, StdOutput = -11, StdError = -12;
    private const uint HandleFlagInherit = 0x1, UseStdHandles = 0x100, CreateNoWindow = 0x08000000, Infinite = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public nint Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute;
        public uint Flags;
        public short ShowWindow, Reserved2;
        public nint Reserved3, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public nint Process, Thread;
        public int ProcessId, ThreadId;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint GetStdHandle(int which);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetHandleInformation(nint handle, uint mask, uint flags);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool CreateProcessW(char* application, char* commandLine, nint processAttributes, nint threadAttributes,
        int inheritHandles, uint creationFlags, nint environment, char* currentDirectory, StartupInfo* startupInfo, ProcessInformation* processInformation);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint WaitForSingleObject(nint handle, uint milliseconds);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(nint process, out uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);
}
