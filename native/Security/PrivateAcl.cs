using System.Security.AccessControl;
using System.Security.Principal;

namespace NexusInDesign.Security;

/// <summary>
/// Private storage (backups, audit, runtime): a protected DACL granting full control to the current user and SYSTEM
/// only, inheritance cut. A junction or symbolic link inside private storage is refused.
/// </summary>
internal static class PrivateAcl
{
    private static readonly SecurityIdentifier System = new(WellKnownSidType.LocalSystemSid, null);

    public static void Protect(string path, bool directory, bool recursive = false)
    {
        var user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current user SID unavailable.");
        if (directory)
        {
            var info = new DirectoryInfo(path);
            if (!info.Exists) throw new ToolError("PRIVATE_STORAGE_MISSING", "Le dossier privé est introuvable.");
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new ToolError("PRIVATE_STORAGE_REPARSE_POINT", "Un stockage privé ne peut pas être une jonction ou un lien symbolique.");
            var children = recursive ? info.EnumerateFileSystemInfos("*", SearchOption.AllDirectories).ToList() : [];
            if (children.Any(child => child.Attributes.HasFlag(FileAttributes.ReparsePoint)))
                throw new ToolError("PRIVATE_STORAGE_REPARSE_POINT", "Une jonction ou un lien symbolique est interdit dans un stockage privé.");
            info.SetAccessControl(DirectoryRules(user));
            foreach (var child in children)
            {
                if (child is DirectoryInfo folder) folder.SetAccessControl(DirectoryRules(user));
                else if (child is FileInfo file) file.SetAccessControl(FileRules(user));
            }
        }
        else
        {
            var info = new FileInfo(path);
            if (!info.Exists) throw new ToolError("PRIVATE_STORAGE_MISSING", "Le fichier privé est introuvable.");
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new ToolError("PRIVATE_STORAGE_REPARSE_POINT", "Un fichier privé ne peut pas être un lien.");
            info.SetAccessControl(FileRules(user));
        }
    }

    private static DirectorySecurity DirectoryRules(SecurityIdentifier user)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(System, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static FileSecurity FileRules(SecurityIdentifier user)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(System, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    /// <summary>Creates the folder if needed, refuses links and protects it (recursively).</summary>
    public static string PrepareDirectory(string path)
    {
        Directory.CreateDirectory(path);
        Protect(path, directory: true, recursive: true);
        return Path.GetFullPath(path);
    }
}
