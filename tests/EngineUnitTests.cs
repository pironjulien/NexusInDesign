using System.Diagnostics;
using System.Text.Json.Nodes;
using NexusInDesign.Security;
using NexusInDesign.Verification;
using NexusInDesign.Workflows;

namespace NexusInDesign.Tests;

public sealed class EngineUnitTests : IDisposable
{
    private readonly string folder = Path.Combine(Path.GetTempPath(), "nexusindesign-unit", Guid.NewGuid().ToString("N"));

    public EngineUnitTests() => Directory.CreateDirectory(folder);

    public void Dispose()
    {
        try { Directory.Delete(folder, recursive: true); } catch (IOException) { }
    }

    private string File(string name) => Path.Combine(folder, name);

    internal static void Junction(string link, string target)
    {
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/d /c mklink /J \"{link}\" \"{target}\"") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true })!;
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public void Artifacts_are_checked_structurally()
    {
        Samples.WritePdf(File("a.pdf"));
        Samples.WritePng(File("a.png"));
        Samples.WriteIdml(File("a.idml"));
        Samples.WriteIndd(File("a.indd"));
        Assert.Equal("pdf", Json.Str(ArtifactVerifier.Verify(File("a.pdf"), "pdf"), "kind"));
        Assert.Equal(2, Json.Long(ArtifactVerifier.Verify(File("a.png"), "png"), "width"));
        Assert.Equal("idml", Json.Str(ArtifactVerifier.Verify(File("a.idml"), "idml"), "kind"));
        Assert.Equal("indd", Json.Str(ArtifactVerifier.Verify(File("a.indd"), "indd"), "kind"));

        System.IO.File.WriteAllText(File("bad.pdf"), "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n" + new string('x', 100));
        Assert.Equal("ARTIFACT_PDF_EOF_MISSING", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(File("bad.pdf"), "pdf")).Code);
        var png = System.IO.File.ReadAllBytes(File("a.png"));
        png[^1] ^= 0xff;
        System.IO.File.WriteAllBytes(File("bad.png"), png);
        Assert.Equal("ARTIFACT_PNG_CRC_INVALID", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(File("bad.png"), "png")).Code);
        System.IO.File.WriteAllBytes(File("bad.indd"), new byte[128]);
        Assert.Equal("ARTIFACT_INDD_SIGNATURE_MISMATCH", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(File("bad.indd"), "indd")).Code);
        System.IO.File.WriteAllBytes(File("empty.pdf"), []);
        Assert.Equal("ARTIFACT_EMPTY", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(File("empty.pdf"), "pdf")).Code);
        var idml = System.IO.File.ReadAllBytes(File("a.idml"));
        idml[60] ^= 0xff;
        System.IO.File.WriteAllBytes(File("bad.idml"), idml);
        Assert.StartsWith("ARTIFACT_IDML", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(File("bad.idml"), "idml")).Code);
    }

    [Fact]
    public void Multipage_png_folder_must_match_the_declared_files_exactly()
    {
        string pages = File("pages");
        Samples.WritePng(Path.Combine(pages, "page-0001.png"));
        Samples.WritePng(Path.Combine(pages, "page-0002.png"));
        var declared = new[] { Path.Combine(pages, "page-0001.png"), Path.Combine(pages, "page-0002.png").Replace('\\', '/') };
        Assert.Equal(2, Json.Long(ArtifactVerifier.Verify(pages, "multipage-png", declared), "validPngCount"));
        Assert.Equal("ARTIFACT_PATH_SET_MISMATCH", Assert.Throws<ToolError>(() => ArtifactVerifier.Verify(pages, "multipage-png", declared[..1])).Code);
    }

    [Fact]
    public void Path_policy_resolves_junctions_and_denies_private_roots()
    {
        string root = File("root"), secret = Path.Combine(root, "secret"), outside = File("outside");
        Directory.CreateDirectory(secret);
        Directory.CreateDirectory(outside);
        var policy = PathPolicy.Create([root], [root], [secret]);
        Assert.EndsWith("doc.pdf", policy.ValidateWrite(Path.Combine(root, "new", "doc.pdf"), [".pdf"]));
        Assert.Equal("PATH_DENIED", Assert.Throws<ToolError>(() => policy.ValidateWrite(Path.Combine(secret, "x.pdf"), [".pdf"])).Code);
        Assert.Equal("PATH_EXTENSION_DENIED", Assert.Throws<ToolError>(() => policy.ValidateWrite(Path.Combine(root, "x.exe"), [".pdf"])).Code);
        Assert.Equal("PATH_INVALID", Assert.Throws<ToolError>(() => policy.ValidateWrite("relative.pdf", [".pdf"])).Code);
        string link = Path.Combine(root, "link");
        Junction(link, outside);
        Assert.Equal("PATH_OUTSIDE_ROOTS", Assert.Throws<ToolError>(() => policy.ValidateWrite(Path.Combine(link, "x.pdf"), [".pdf"])).Code);
        Samples.WriteIndd(Path.Combine(outside, "a.indd"));
        Assert.Equal("PATH_OUTSIDE_ROOTS", Assert.Throws<ToolError>(() => policy.ValidateRead(Path.Combine(link, "a.indd"), [".indd"])).Code);
        Directory.Delete(link);
    }

    [Fact]
    public void Configuration_keeps_private_storage_out_of_OneDrive_and_only_the_core_profile()
    {
        string profile = File("profile");
        var defaults = Config.Load(new Dictionary<string, string?> { ["USERPROFILE"] = profile });
        Assert.Equal(Path.Combine(profile, ".nexus", "nexus-indesign", "private"), defaults.PrivateRoot);
        Assert.Equal([profile], defaults.ReadRoots);
        Assert.Contains(Path.Combine(profile, ".nexus"), defaults.DeniedRoots);
        Assert.Contains(defaults.AllowedParents, parent => parent.ExecutableName == "claude.exe" && parent.Signer == "Anthropic, PBC");
        Assert.Contains(defaults.AllowedParents, parent => parent.ExecutableName == "codex.exe");
        var oneDrive = Assert.Throws<ToolError>(() => Config.Load(new Dictionary<string, string?>
        {
            ["USERPROFILE"] = profile, ["OneDrive"] = profile, ["INDESIGN_MCP_PRIVATE_ROOT"] = Path.Combine(profile, "private"),
        }));
        Assert.Equal("CONFIG_INVALID", oneDrive.Code);
        Assert.Throws<ToolError>(() => Config.Load(new Dictionary<string, string?> { ["USERPROFILE"] = profile, ["INDESIGN_MCP_TOOL_PROFILE"] = "full" }));
        Directory.CreateDirectory(Path.Combine(profile, ".nexus", "nexus-indesign"));
        System.IO.File.WriteAllText(Path.Combine(profile, ".nexus", "nexus-indesign", "settings.json"),
            new JsonObject { ["readRoots"] = new JsonArray(@"C:\Dev"), ["deniedRoots"] = new JsonArray(@"C:\Secret") }.ToJsonString());
        var configured = Config.Load(new Dictionary<string, string?> { ["USERPROFILE"] = profile });
        Assert.Equal([@"C:\Dev"], configured.ReadRoots);
        Assert.Contains(@"C:\Secret", configured.DeniedRoots);
    }

    [Fact]
    public void Codex_desktop_versioned_engine_is_in_the_default_parent_roots()
    {
        string profile = File("profile"), local = Path.Combine(profile, "AppData", "Local");
        var environment = new Dictionary<string, string?> { ["USERPROFILE"] = profile, ["LOCALAPPDATA"] = local };
        var defaults = Config.Load(environment);
        string codex = Path.Combine(local, "OpenAI", "Codex", "bin");
        Assert.Contains(defaults.AllowedParentPaths, root => PathPolicy.IsInside(root, Path.Combine(codex, "build-id", "codex.exe")));
        Assert.DoesNotContain(defaults.AllowedParentPaths, root => PathPolicy.IsInside(root, Path.Combine(codex + "-evil", "codex.exe")));
        Assert.Contains(defaults.AllowedParents, parent => parent.ExecutableName == "codex.exe" && parent.Signer == "OpenAI");

        string explicitRoot = File("explicit-agent");
        environment["INDESIGN_MCP_ALLOWED_PARENT_PATHS"] = explicitRoot;
        Assert.Equal([explicitRoot], Config.Load(environment).AllowedParentPaths);
    }

    [Fact]
    public void The_test_host_is_not_an_allowed_parent()
    {
        var policy = new ParentProcessPolicy([new AllowedParent("claude.exe", "Anthropic, PBC"), new AllowedParent("codex.exe", "OpenAI")],
            [@"C:\Program Files\WindowsApps"]);
        Assert.Equal("PARENT_NOT_ALLOWED", Assert.Throws<ToolError>(() => policy.Verify()).Code);
        var chain = ParentProcessPolicy.ParentChain(Environment.ProcessId).ToList();
        Assert.Equal(Environment.ProcessId, chain[0].ProcessId);
        Assert.EndsWith(".exe", chain[0].ExecutablePath, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Authenticode_is_checked_with_WinVerifyTrust()
    {
        string signed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "notepad.exe");
        if (!System.IO.File.Exists(signed)) signed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        System.IO.File.WriteAllBytes(File("unsigned.exe"), [0x4d, 0x5a, 0, 0]);
        Assert.False(ParentProcessPolicy.SignatureValid(File("unsigned.exe")));
        // System binaries are catalog-signed: valid for WinVerifyTrust through the catalog only when policy allows it;
        // the engine requires an embedded signer subject as well, which agents (claude.exe, codex.exe) carry.
        _ = ParentProcessPolicy.SignatureValid(signed);
    }

    [Fact]
    public void Audit_lines_hash_the_reason_and_drop_free_code_errors()
    {
        var logger = new AuditLogger(File("audit.jsonl"));
        logger.Write(new AuditLogger.Event("tool_call", "export_pdf", "error") { Reason = "secret reason", ErrorCode = "PATH_DENIED", BackupIds = ["0123456789abcdef0123456789abcdef0123"] });
        logger.Write(new AuditLogger.Event("tool_call", "run_layout_script", "error") { ErrorCode = "UXP_ERROR" });
        var lines = System.IO.File.ReadAllLines(File("audit.jsonl")).Select(line => JsonNode.Parse(line)!.AsObject()).ToList();
        Assert.Equal("PATH_DENIED", Json.Str(lines[0], "errorCode"));
        Assert.Equal(Json.Sha256("secret reason"), Json.Str(lines[0], "reasonHash"));
        Assert.DoesNotContain("secret reason", System.IO.File.ReadAllText(File("audit.jsonl")));
        Assert.Null(lines[1]["errorCode"]);
    }

    [Fact]
    public void Retention_keeps_recent_backups_and_open_restored_copies()
    {
        string backups = File("backups");
        Directory.CreateDirectory(Path.Combine(backups, "restored"));
        string old = Path.Combine(backups, $"backup-{Guid.NewGuid():D}.indd"), recent = Path.Combine(backups, $"backup-{Guid.NewGuid():D}.indd");
        Samples.WriteIndd(old);
        Samples.WriteIndd(recent);
        System.IO.File.WriteAllText(Path.ChangeExtension(old, ".meta.json"), "{}");
        System.IO.File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddDays(-3));
        string id = Guid.NewGuid().ToString("D");
        string restored = Path.Combine(backups, "restored", $"restore-{id}.indd");
        Samples.WriteIndd(restored);
        System.IO.File.SetLastWriteTimeUtc(restored, DateTime.UtcNow.AddDays(-3));
        System.IO.File.WriteAllText(Path.Combine(backups, "restored", $"restore-{id}.open.json"), "{}");
        var result = BackupRetention.Cleanup(backups, File("no-lease.json"), TimeSpan.FromHours(24), 200);
        Assert.Equal(1, Json.Long(result, "removed"));
        Assert.False(System.IO.File.Exists(old));
        Assert.False(System.IO.File.Exists(Path.ChangeExtension(old, ".meta.json")));
        Assert.True(System.IO.File.Exists(recent));
        Assert.True(System.IO.File.Exists(restored));
        System.IO.File.WriteAllText(File("lease.json"), "{}");
        Assert.True(Json.IsTrue(BackupRetention.Cleanup(backups, File("lease.json"), TimeSpan.Zero, 0), "skippedForActiveMutation"));
    }

    [Fact]
    public void Layout_fingerprint_ignores_identity_and_order_and_lint_applies_the_contract()
    {
        JsonObject Snapshot(bool swap, string name) => new()
        {
            ["documentId"] = 7, ["revision"] = 3, ["capturedAt"] = DateTime.UtcNow.ToString("o"),
            ["document"] = new JsonObject { ["id"] = 7, ["name"] = name, ["facingPages"] = true },
            ["pages"] = new JsonArray(new JsonObject { ["id"] = 1, ["widthMm"] = 210, ["heightMm"] = 297, ["bounds"] = new JsonArray(0, 0, 297, 210), ["margins"] = new JsonObject { ["top"] = 5 } }),
            ["items"] = swap
                ? new JsonArray(new JsonObject { ["id"] = 2, ["pageId"] = 1, ["bounds"] = new JsonArray(0, 0, 10, 10), ["overflows"] = true }, new JsonObject { ["id"] = 1, ["pageId"] = 1, ["bounds"] = new JsonArray(0, 0, 10, 10) })
                : new JsonArray(new JsonObject { ["id"] = 1, ["pageId"] = 1, ["bounds"] = new JsonArray(0, 0, 10, 10) }, new JsonObject { ["id"] = 2, ["pageId"] = 1, ["bounds"] = new JsonArray(0, 0, 10, 10), ["overflows"] = true }),
            ["fonts"] = new JsonArray(new JsonObject { ["name"] = "Minion Pro", ["statusName"] = "NOT_AVAILABLE" }),
            ["designSystem"] = new JsonObject { ["paragraphStyles"] = new JsonArray() },
        };
        Assert.Equal(LayoutWorkflow.Fingerprint(Snapshot(false, "a.indd")), LayoutWorkflow.Fingerprint(Snapshot(true, "b.indd")));
        var lint = LayoutWorkflow.Lint(Snapshot(false, "a"), new JsonObject { ["minMarginMm"] = 10, ["requiredParagraphStyles"] = new JsonArray("Titre") });
        var codes = ((JsonArray)lint["issues"]!).Select(issue => Json.Str(issue, "code")).ToHashSet();
        Assert.Contains("OVERSET_TEXT", codes);
        Assert.Contains("MISSING_FONT", codes);
        Assert.Contains("MARGIN_BELOW_CONTRACT", codes);
        Assert.Contains("REQUIRED_PARAGRAPH_STYLE_MISSING", codes);
        Assert.False(Json.IsTrue(lint, "passed"));
    }
}
