using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusInDesign.Security;

/// <summary>
/// Backups older than the retention or beyond the count limit are removed, never during a mutation and never a restored
/// copy whose marker says it may still be open in InDesign.
/// </summary>
internal static partial class BackupRetention
{
    [GeneratedRegex("^backup-[a-f0-9-]{24,80}\\.indd$", RegexOptions.IgnoreCase)] private static partial Regex BackupName();
    [GeneratedRegex("^target-backup-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\\.[a-z0-9]{1,12})?$", RegexOptions.IgnoreCase)] private static partial Regex TargetBackupName();
    [GeneratedRegex("^restore-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\\.indd$", RegexOptions.IgnoreCase)] private static partial Regex RestoredName();

    private sealed record Candidate(string Path, DateTime Modified, bool Directory, List<string> Companions);

    public static JsonObject Cleanup(string directory, string leasePath, TimeSpan maxAge, int maxFiles, DateTime? now = null)
    {
        var at = now ?? DateTime.UtcNow;
        if (File.Exists(leasePath)) return new JsonObject { ["inspected"] = 0, ["removed"] = 0, ["skippedForActiveMutation"] = true };
        var candidates = new List<Candidate>();
        foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
        {
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            bool backup = BackupName().IsMatch(entry.Name);
            if (!backup && !TargetBackupName().IsMatch(entry.Name)) continue;
            var companions = new List<string>();
            if (backup)
            {
                string metadata = System.IO.Path.ChangeExtension(entry.FullName, ".meta.json");
                if (File.Exists(metadata)) companions.Add(metadata);
            }
            candidates.Add(new Candidate(entry.FullName, entry.LastWriteTimeUtc, entry is DirectoryInfo, companions));
        }
        int skippedOpen = 0;
        string restored = System.IO.Path.Combine(directory, "restored");
        if (System.IO.Directory.Exists(restored) && !new DirectoryInfo(restored).Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            foreach (var file in new DirectoryInfo(restored).EnumerateFiles())
            {
                var match = RestoredName().Match(file.Name);
                if (!match.Success || file.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
                // A marker, even unreadable, means "possibly open": retention keeps rather than loses active work.
                if (File.Exists(System.IO.Path.Combine(restored, $"restore-{match.Groups[1].Value}.open.json"))) { skippedOpen++; continue; }
                candidates.Add(new Candidate(file.FullName, file.LastWriteTimeUtc, false, []));
            }
        }
        candidates.Sort((left, right) => right.Modified.CompareTo(left.Modified));
        int removed = 0;
        for (int index = 0; index < candidates.Count; index++)
        {
            var candidate = candidates[index];
            if (index < maxFiles && at - candidate.Modified <= maxAge) continue;
            if (candidate.Directory) System.IO.Directory.Delete(candidate.Path, recursive: true);
            else File.Delete(candidate.Path);
            foreach (string companion in candidate.Companions) File.Delete(companion);
            removed++;
        }
        return new JsonObject { ["inspected"] = candidates.Count, ["removed"] = removed, ["skippedOpenRestored"] = skippedOpen };
    }
}
