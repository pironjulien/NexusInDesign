using System.Text.Json.Nodes;

namespace NexusInDesign.Security;

/// <summary>
/// An export target that already exists is replaced only with overwrite=true, and only after a private copy of it
/// (target-backup-*) restorable by hand. Links inside a target folder are refused.
/// </summary>
internal static class OutputProtection
{
    public static JsonObject Prepare(string targetPath, string kind, bool overwrite, string backupRoot)
    {
        bool isFile = File.Exists(targetPath), isDirectory = Directory.Exists(targetPath);
        if (!isFile && !isDirectory) return [];
        FileSystemInfo info = isFile ? new FileInfo(targetPath) : new DirectoryInfo(targetPath);
        if ((kind == "file" && !isFile) || (kind == "directory" && !isDirectory) || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new ToolError("TARGET_TYPE_MISMATCH", "La cible existante n’a pas le type attendu.");
        if (!overwrite)
            throw new ToolError("TARGET_EXISTS", "La cible existe déjà. Transmettez overwrite=true pour autoriser son remplacement après copie de sécurité.");
        if (isDirectory && new DirectoryInfo(targetPath).EnumerateFileSystemInfos("*", SearchOption.AllDirectories).Any(entry => entry.Attributes.HasFlag(FileAttributes.ReparsePoint)))
            throw new ToolError("TARGET_REPARSE_POINT", "La cible contient une jonction ou un lien symbolique.");
        string id = Json.NewId();
        string extension = isFile ? Path.GetExtension(targetPath).ToLowerInvariant() : "";
        string backup = Path.Combine(backupRoot, $"target-backup-{id}{extension}");
        try
        {
            if (isFile) File.Copy(targetPath, backup, overwrite: false);
            else CopyDirectory(targetPath, backup);
        }
        catch
        {
            try
            {
                if (isFile) File.Delete(backup);
                else if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
            }
            catch (IOException) { }
            throw;
        }
        return new JsonObject
        {
            ["targetBackupId"] = id, ["targetBackupPath"] = backup, ["targetBackupKind"] = kind,
            ["targetBackupCreatedAt"] = DateTime.UtcNow.ToString("o"),
        };
    }

    private static void CopyDirectory(string source, string target)
    {
        if (Directory.Exists(target)) throw new IOException("La copie de sécurité de la cible existe déjà.");
        Directory.CreateDirectory(target);
        foreach (string directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        foreach (string file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(target, Path.GetRelativePath(source, file)), overwrite: false);
    }
}
