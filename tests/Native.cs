using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace NexusInDesign.Tests;

internal static partial class Native
{
    private const uint ListDirectory = 0x1, ShareRead = 0x1, ShareWrite = 0x2, OpenExisting = 3, BackupSemantics = 0x02000000;

    /// <summary>A handle on a folder that shares reading and writing but not deletion: the folder cannot be renamed
    /// while it is open, as when a scanner holds it. Invalid when the folder cannot be opened.</summary>
    public static SafeFileHandle OpenFolder(string path) => CreateFileW(path, ListDirectory, ShareRead | ShareWrite, 0, OpenExisting, BackupSemantics, 0);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
}
