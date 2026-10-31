using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;

namespace NexusInDesign.Security;

/// <summary>A process of the parent chain: its executable and Authenticode signer.</summary>
internal sealed record ProcessIdentity(int ProcessId, int ParentProcessId, string? ExecutablePath, DateTime? StartedAtUtc);

/// <summary>An agent allowed to start the server: executable name and signer, in one of the allowed folders.</summary>
internal sealed record AllowedParent(string ExecutableName, string Signer);

internal interface IParentVerifier
{
    JsonObject Verify();
}

/// <summary>
/// The server starts only under an allowed AI agent: one ancestor (up to 20 levels) must be claude.exe signed by
/// Anthropic or codex.exe signed by OpenAI (by default), with a valid Authenticode signature, in an allowed folder.
/// Any other local program that runs the executable is refused before InDesign is touched.
/// </summary>
internal sealed class ParentProcessPolicy(IReadOnlyList<AllowedParent> allowed, IReadOnlyList<string> allowedPaths, int? parentProcessId = null) : IParentVerifier
{
    public JsonObject Verify()
    {
        if (allowed.Count == 0) throw new ToolError("PARENT_POLICY_INVALID", "Aucun agent autorisé n’est configuré.");
        if (allowedPaths.Count == 0) throw new ToolError("PARENT_POLICY_INVALID", "Aucun dossier d’agent autorisé n’est configuré.");
        foreach (var process in ParentChain(parentProcessId ?? ParentOf(Environment.ProcessId) ?? 0))
        {
            if (process.ExecutablePath is not { } path) continue;
            string name = Path.GetFileName(path);
            var candidates = allowed.Where(entry => entry.ExecutableName.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (candidates.Count == 0 || !allowedPaths.Any(root => PathPolicy.IsInside(Path.GetFullPath(root), Path.GetFullPath(path)))) continue;
            string? subject = SignerSubject(path);
            if (subject is null || !SignatureValid(path)) continue;
            if (!candidates.Any(entry => subject.Contains(entry.Signer, StringComparison.OrdinalIgnoreCase))) continue;
            return new JsonObject { ["verified"] = true, ["processId"] = process.ProcessId, ["executablePath"] = path, ["signerSubject"] = subject };
        }
        throw new ToolError("PARENT_NOT_ALLOWED", "Démarrage refusé : aucun ancêtre Claude ou Codex signé ne correspond à la liste autorisée.");
    }

    /// <summary>Ancestors from the parent upwards; a parent started after its child (PID reuse) ends the chain.</summary>
    internal static IEnumerable<ProcessIdentity> ParentChain(int startProcessId)
    {
        var parents = Snapshot();
        int current = startProcessId;
        DateTime? childStart = null;
        var seen = new HashSet<int>();
        for (int depth = 0; depth < 20 && current > 0 && seen.Add(current); depth++)
        {
            if (!parents.TryGetValue(current, out int parent)) yield break;
            var started = StartTime(current);
            if (childStart is { } child && started is { } own && own > child) yield break;
            yield return new ProcessIdentity(current, parent, ImagePath(current), started);
            childStart = started;
            current = parent;
        }
    }

    internal static int? ParentOf(int processId) => Snapshot().TryGetValue(processId, out int parent) ? parent : null;

    internal static DateTime? StartTime(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.StartTime.ToUniversalTime();
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    private static Dictionary<int, int> Snapshot()
    {
        var map = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snapshot == new IntPtr(-1)) return map;
        try
        {
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            if (!Process32FirstW(snapshot, ref entry)) return map;
            do map[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
            while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return map;
    }

    private static string? ImagePath(int processId)
    {
        IntPtr handle = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) return null;
        try
        {
            var buffer = new char[32768];
            int size = buffer.Length;
            return QueryFullProcessImageNameW(handle, 0, buffer, ref size) ? new string(buffer, 0, size) : null;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static string? SignerSubject(string path)
    {
        try
        {
#pragma warning disable SYSLIB0057 // The signer of an Authenticode-signed file; X509CertificateLoader does not read PE signatures.
            using var certificate = X509Certificate.CreateFromSignedFile(path);
#pragma warning restore SYSLIB0057
            return certificate.Subject;
        }
        catch (Exception exception) when (exception is System.Security.Cryptography.CryptographicException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>WinVerifyTrust (Authenticode policy, no UI, no network revocation check).</summary>
    internal static bool SignatureValid(string path)
    {
        var file = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(), pcwszFilePath = path };
        IntPtr fileInfo = Marshal.AllocHGlobal(Marshal.SizeOf<WINTRUST_FILE_INFO>());
        try
        {
            Marshal.StructureToPtr(file, fileInfo, false);
            var data = new WINTRUST_DATA
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
                dwUIChoice = 2,          // WTD_UI_NONE
                fdwRevocationChecks = 0, // WTD_REVOKE_NONE
                dwUnionChoice = 1,       // WTD_CHOICE_FILE
                pFile = fileInfo,
                dwStateAction = 0,
                dwProvFlags = 0x00000080, // WTD_REVOCATION_CHECK_NONE
            };
            var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
            return WinVerifyTrust(new IntPtr(-1), ref action, ref data) == 0;
        }
        finally
        {
            Marshal.FreeHGlobal(fileInfo);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
        public IntPtr hFile, pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData, pSIPClientData;
        public uint dwUIChoice, fdwRevocationChecks, dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData, pwszURLReference;
        public uint dwProvFlags, dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, [Out] char[] name, ref int size);
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref WINTRUST_DATA data);
}

/// <summary>Ends the server when the agent that started it is gone (same PID and start time no longer running).</summary>
internal sealed class ParentWatchdog : IDisposable
{
    private readonly Timer timer;

    public ParentWatchdog(int parentProcessId, Action onExit)
    {
        var started = ParentProcessPolicy.StartTime(parentProcessId);
        timer = new Timer(_ =>
        {
            var now = ParentProcessPolicy.StartTime(parentProcessId);
            if (started is null || now is null || Math.Abs((now.Value - started.Value).TotalSeconds) >= 1) onExit();
        }, null, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2));
    }

    public void Dispose() => timer.Dispose();
}
