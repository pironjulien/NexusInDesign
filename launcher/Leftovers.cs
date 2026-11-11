namespace NexusInDesign.Launcher;

/// <summary>
/// What an update leaves behind once nothing uses it any more: the folders of older versions under versions\ and the
/// launchers renamed aside (NexusInDesign.exe.old-&lt;id&gt;). get.ps1 removes them when it installs, but keeps the
/// folder of an engine a session still runs and the launcher that session still runs; nothing removed them afterwards
/// until the next version. The launcher does it at each session start, on a background thread of low priority that
/// never delays the session and whose failures are ignored (the next start tries again). The rules are get.ps1's:
/// <list type="bullet">
/// <item>nothing is removed unless current.txt names a version folder that holds its engine;</item>
/// <item>that folder stays, and so does a folder created less than <see cref="Grace"/> ago (an installation that has
/// just written it and checks it before switching current.txt to it);</item>
/// <item>a folder whose engine a process runs stays: a running image cannot be opened for writing, which is checked
/// first, because Windows lets a folder be renamed while a program inside it runs;</item>
/// <item>a folder is renamed to versions\.trash-&lt;id&gt; before its contents are deleted, so a version folder is
/// never left half deleted; a trash folder left by an interrupted removal goes at the next start;</item>
/// <item>a renamed launcher goes once no process runs it (a running image cannot be deleted).</item>
/// </list>
/// Measured cost when nothing is left (current.txt read, two folder listings): about 0.2 ms, so it runs at every
/// session start, with no timestamp file to throttle it.
/// </summary>
internal static class Leftovers
{
    internal const string Pointer = "current.txt", Trash = ".trash-";

    /// <summary>How long a fresh version folder is left alone.</summary>
    internal static readonly TimeSpan Grace = TimeSpan.FromMinutes(10);

    /// <summary>Starts the removal in the background; it ends with the launcher if not finished by then.</summary>
    internal static void Start(string home)
    {
        var thread = new Thread(() =>
        {
            try { Remove(home, DateTime.UtcNow); }
            catch (Exception) { } // never a failure of the session: the next start tries again
        })
        { IsBackground = true, Priority = ThreadPriority.Lowest, Name = "Leftovers" };
        try { thread.Start(); }
        catch (Exception) { } // no thread, no removal: the session starts all the same
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

    /// <summary>Removes what nothing uses any more; returns the names of the version folders removed.</summary>
    internal static List<string> Remove(string home, DateTime nowUtc)
    {
        var removed = new List<string>();
        string versions = Path.Combine(home, "versions");
        string keep;
        try { keep = File.ReadAllText(Path.Combine(home, Pointer)).Trim(); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return removed; }
        if (!IsVersionFolder(keep) || !File.Exists(Path.Combine(versions, keep, "NexusInDesign.exe"))) return removed;

        foreach (string launcher in Directory.EnumerateFiles(home, "NexusInDesign.exe.old-*"))
        {
            try { File.Delete(launcher); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { } // still running
        }

        foreach (string folder in Directory.GetDirectories(versions))
        {
            string name = Path.GetFileName(folder);
            if (name.StartsWith(Trash, StringComparison.Ordinal))
            {
                Purge(folder);
                continue;
            }
            if (!IsVersionFolder(name) || name == keep) continue;
            try
            {
                if (Directory.GetCreationTimeUtc(folder) > nowUtc - Grace || Running(folder)) continue;
                string trash = Path.Combine(versions, Trash + Guid.NewGuid().ToString("N"));
                Directory.Move(folder, trash);
                removed.Add(name);
                Purge(trash);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { } // held: next start
        }
        return removed;
    }

    /// <summary>
    /// Whether a process runs (or anything holds) the folder's engine: Windows refuses to open a running image for
    /// writing. Nothing is written.
    /// </summary>
    private static bool Running(string folder)
    {
        string engine = Path.Combine(folder, "NexusInDesign.exe");
        if (!File.Exists(engine)) return false;
        try
        {
            using var probe = new FileStream(engine, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            return false;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return true; }
    }

    /// <summary>Deletes a trash folder, its engine first: one still running keeps the whole folder for a later start.</summary>
    private static void Purge(string trash)
    {
        try
        {
            string engine = Path.Combine(trash, "NexusInDesign.exe");
            if (File.Exists(engine)) File.Delete(engine);
            Directory.Delete(trash, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }
}
