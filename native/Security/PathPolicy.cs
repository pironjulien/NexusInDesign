namespace NexusInDesign.Security;

/// <summary>
/// Paths a structured tool may read or write: inside the allowed roots once every link is resolved, never inside a
/// denied root (private storage, secrets), with the extension the tool expects.
/// </summary>
internal sealed class PathPolicy
{
    private readonly IReadOnlyList<string> readRoots;
    private readonly IReadOnlyList<string> writeRoots;
    private readonly IReadOnlyList<string> deniedRoots;

    private PathPolicy(IReadOnlyList<string> readRoots, IReadOnlyList<string> writeRoots, IReadOnlyList<string> deniedRoots)
    {
        this.readRoots = readRoots;
        this.writeRoots = writeRoots;
        this.deniedRoots = deniedRoots;
    }

    public IReadOnlyList<string> ReadRoots => readRoots;
    public IReadOnlyList<string> WriteRoots => writeRoots;
    public IReadOnlyList<string> DeniedRoots => deniedRoots;

    public static PathPolicy Create(IEnumerable<string> readRoots, IEnumerable<string> writeRoots, IEnumerable<string> deniedRoots)
    {
        static List<string> Canonical(IEnumerable<string> roots, bool mustExist)
        {
            var list = new List<string>();
            foreach (string root in roots)
            {
                if (!Directory.Exists(root))
                {
                    if (mustExist) throw new ToolError("CONFIG_INVALID", Strings.T($"The allowed root is not a folder: {root}", $"La racine autorisée n’est pas un dossier : {root}"));
                    list.Add(Path.GetFullPath(root));
                    continue;
                }
                list.Add(RealPath(root));
            }
            return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        // Allowed roots that do not exist are skipped (a D:\ that is absent today); denied ones are kept as written.
        return new PathPolicy(
            Canonical(readRoots.Where(Directory.Exists), mustExist: true),
            Canonical(writeRoots.Where(Directory.Exists), mustExist: true),
            Canonical(deniedRoots, mustExist: false));
    }

    internal static bool IsInside(string root, string candidate)
    {
        string relative = Path.GetRelativePath(root, candidate);
        return relative == "." || (!relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative));
    }

    /// <summary>The path with every symbolic link and junction resolved (the target of the last existing link).</summary>
    internal static string RealPath(string path)
    {
        string full = Path.GetFullPath(path);
        string root = Path.GetPathRoot(full)!;
        string current = root;
        foreach (string part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (!info.Exists) throw new FileNotFoundException("Path not found.", current);
            if (info.LinkTarget is not null)
            {
                var target = info.ResolveLinkTarget(returnFinalTarget: true);
                current = target is null ? current : Path.GetFullPath(target.FullName);
            }
        }
        return current;
    }

    private static void ValidateRaw(string candidate)
    {
        if (string.IsNullOrEmpty(candidate) || candidate.Contains('\0', StringComparison.Ordinal) || !Path.IsPathFullyQualified(candidate))
            throw new ToolError("PATH_INVALID", Strings.T("The path must be absolute and valid.", "Le chemin doit être absolu et valide."));
    }

    private void AssertNotDenied(string candidate, string operation)
    {
        if (deniedRoots.Any(root => IsInside(root, candidate)))
            throw new ToolError("PATH_DENIED", Strings.T($"{operation} refused: the real path enters a denied private root.", $"{operation} refusée : le chemin réel entre dans une racine privée interdite."));
    }

    private static bool ExtensionAllowed(string candidate, IReadOnlyCollection<string>? extensions) =>
        extensions is null || extensions.Count == 0 || extensions.Contains(Path.GetExtension(candidate).ToLowerInvariant());

    public string ValidateRead(string candidate, IReadOnlyCollection<string>? extensions, string kind = "file")
    {
        ValidateRaw(candidate);
        string canonical;
        try { canonical = RealPath(candidate); }
        catch (FileNotFoundException) { throw new ToolError("PATH_NOT_FOUND", Strings.T("Read refused: the path does not exist.", "Lecture refusée : le chemin est introuvable.")); }
        AssertNotDenied(canonical, Strings.T("Read", "Lecture"));
        if (!readRoots.Any(root => IsInside(root, canonical)))
            throw new ToolError("PATH_OUTSIDE_ROOTS", Strings.T("Read refused: the real path is outside the allowed roots.", "Lecture refusée : le chemin réel sort des racines autorisées."));
        if (kind == "file" && !File.Exists(canonical)) throw new ToolError("PATH_TYPE_MISMATCH", Strings.T("Read refused: a file is expected.", "Lecture refusée : un fichier est attendu."));
        if (kind == "directory" && !Directory.Exists(canonical)) throw new ToolError("PATH_TYPE_MISMATCH", Strings.T("Read refused: a folder is expected.", "Lecture refusée : un dossier est attendu."));
        if (kind == "file" && !ExtensionAllowed(canonical, extensions))
            throw new ToolError("PATH_EXTENSION_DENIED", Strings.T("Read refused: extension not allowed for this tool.", "Lecture refusée : extension non autorisée pour cet outil."));
        return canonical;
    }

    public string ValidateWrite(string candidate, IReadOnlyCollection<string>? extensions, string kind = "file")
    {
        ValidateRaw(candidate);
        string absolute = Path.GetFullPath(candidate);
        if (kind == "file" && !ExtensionAllowed(absolute, extensions))
            throw new ToolError("PATH_EXTENSION_DENIED", Strings.T("Write refused: extension not allowed for this tool.", "Écriture refusée : extension non autorisée pour cet outil."));
        string existing = absolute;
        while (!File.Exists(existing) && !Directory.Exists(existing))
        {
            string? parent = Path.GetDirectoryName(existing);
            if (parent is null || parent == existing) throw new ToolError("PATH_NOT_FOUND", Strings.T("Write refused: no existing parent.", "Écriture refusée : aucun parent existant."));
            existing = parent;
        }
        string realParent = RealPath(existing);
        AssertNotDenied(realParent, Strings.T("Write", "Écriture"));
        if (!writeRoots.Any(root => IsInside(root, realParent)))
            throw new ToolError("PATH_OUTSIDE_ROOTS", Strings.T("Write refused: the real path is outside the allowed roots.", "Écriture refusée : le chemin réel sort des racines autorisées."));
        if (!File.Exists(absolute) && !Directory.Exists(absolute))
            return realParent == existing ? absolute : Path.Combine(realParent, Path.GetRelativePath(existing, absolute));
        string canonical = RealPath(absolute);
        AssertNotDenied(canonical, Strings.T("Write", "Écriture"));
        if (kind == "file" && !File.Exists(canonical)) throw new ToolError("PATH_TYPE_MISMATCH", Strings.T("Write refused: the existing target is not a file.", "Écriture refusée : la cible existante n’est pas un fichier."));
        if (kind == "directory" && !Directory.Exists(canonical)) throw new ToolError("PATH_TYPE_MISMATCH", Strings.T("Write refused: the existing target is not a folder.", "Écriture refusée : la cible existante n’est pas un dossier."));
        if (!writeRoots.Any(root => IsInside(root, canonical)))
            throw new ToolError("PATH_OUTSIDE_ROOTS", Strings.T("Write refused: the real target is outside the allowed roots.", "Écriture refusée : la cible réelle sort des racines autorisées."));
        return canonical;
    }
}
