using System.Diagnostics;
using System.Text.Json.Nodes;
using NexusInDesign.InDesign;

namespace NexusInDesign.Tests;

public sealed class HostAndTemplateTests
{
    private static string TestMutex() => $@"Local\NexusInDesignAutomation.Test.{Guid.NewGuid():D}";

    private static ScriptRun GuardOnly(Action guard) => new("status.js", ScriptLanguage.Uxp, @"C:\nowhere.idjs", null, TimeSpan.FromSeconds(5), [])
    {
        Guard = guard,
    };

    [Fact]
    public async Task The_guard_runs_under_the_shared_mutex_before_any_COM_call()
    {
        string name = TestMutex();
        using var host = new ComInDesignHost(name);
        bool heldDuringGuard = false;
        var error = await Assert.ThrowsAsync<ToolError>(() => host.RunAsync(GuardOnly(() =>
        {
            heldDuringGuard = !Task.Run(() =>
            {
                using var probe = new Mutex(false, name);
                bool free = probe.WaitOne(0);
                if (free) probe.ReleaseMutex();
                return free;
            }).Result;
            throw new ToolError("MUTATION_IN_PROGRESS", "lease");
        })));
        Assert.Equal("MUTATION_IN_PROGRESS", error.Code);
        Assert.True(heldDuringGuard);
        using var after = new Mutex(false, name);
        Assert.True(after.WaitOne(TimeSpan.FromSeconds(5)));
        after.ReleaseMutex();
    }

    [Fact]
    public async Task An_abandoned_mutex_refuses_the_next_command_once()
    {
        string name = TestMutex();
        var thread = new Thread(() => new Mutex(false, name).WaitOne());
        thread.Start();
        thread.Join();
        using var host = new ComInDesignHost(name);
        var abandoned = await Assert.ThrowsAsync<ToolError>(() => host.RunAsync(GuardOnly(() => throw new ToolError("NEVER", "never"))));
        Assert.Equal("INDESIGN_MUTEX_ABANDONED", abandoned.Code);
        Assert.True(abandoned.RequiresInspection);
        var next = await Assert.ThrowsAsync<ToolError>(() => host.RunAsync(GuardOnly(() => throw new ToolError("GUARD_REACHED", "ok"))));
        Assert.Equal("GUARD_REACHED", next.Code);
    }

    [Fact]
    public async Task An_operation_hold_keeps_the_mutex_across_its_scripts()
    {
        string name = TestMutex();
        using var host = new ComInDesignHost(name);
        var hold = await host.HoldAsync(Guid.NewGuid().ToString("D"));
        bool Free() => Task.Run(() =>
        {
            using var probe = new Mutex(false, name);
            bool free = probe.WaitOne(0);
            if (free) probe.ReleaseMutex();
            return free;
        }).Result;
        Assert.False(Free());
        var inside = await Assert.ThrowsAsync<ToolError>(() => host.RunAsync(GuardOnly(() => throw new ToolError("INSIDE", "ok")) with { Hold = hold }));
        Assert.Equal("INSIDE", inside.Code);
        Assert.False(Free());
        await hold.DisposeAsync();
        Assert.True(Free());
    }

    private static Dictionary<string, string> SampleInputs(string template) => template switch
    {
        _ => new Dictionary<string, string>
        {
            ["documentId"] = "12", ["expectedRevision"] = "3", ["expectedStateToken"] = "\"0123456789abcdef\"",
            ["expectedDocuments"] = "[{\"documentId\":12,\"revision\":3,\"stateToken\":\"0123456789abcdef\"}]",
            ["input"] = "{\"a\":1}", ["code"] = Json.Literal("return doc.name;\n// \u2028 line"), ["maxItems"] = "20000", ["resultBudget"] = "1000000",
            ["includePages"] = "true", ["includeItems"] = "true", ["includeLinks"] = "false", ["includeFonts"] = "true",
            ["includeImages"] = "true", ["includeOverset"] = "true", ["includeDesignSystem"] = "true", ["includeTypography"] = "true", ["profileName"] = "null",
            ["timeoutSeconds"] = "60", ["filePath"] = "\"C:/out/a.pdf\"", ["profileBudgetMs"] = "9000",
            ["spec"] = "{\"width\":210,\"height\":297,\"pageCount\":1,\"facingPages\":true,\"margins\":[1,1,1,1],\"bleed\":[3,3,3,3]}",
            ["savePath"] = "null", ["presetName"] = "null", ["folderPath"] = "\"C:/out\"", ["pageId"] = "null", ["pageRange"] = "\"all\"",
            ["resolution"] = "300", ["transparentBackground"] = "false", ["slots"] = "[\"C:/b/1.indd\"]", ["save"] = "false", ["close"] = "false",
            ["previewPages"] = "String(target.doc.pages.item(0).name)", ["previewResolution"] = "96", ["previewPath"] = "\"C:/p/x.png\"", ["undoName"] = "\"Nexus : essai\"",
            ["annotateCopyPath"] = "\"C:/r/a.indd\"", ["restoredWorkingPath"] = "\"C:/r/x.indd\"", ["backupPath"] = "\"C:/b/x.indd\"", ["backupId"] = "\"x\"",
            ["options"] = "{\"folderPath\":\"C:/pkg\",\"includeFonts\":true,\"includeLinks\":true,\"includeProfiles\":true,\"includeHiddenLayers\":false,\"ignorePreflightErrors\":false,\"includeIdml\":true,\"includePdf\":true,\"pdfPresetName\":\"\"}",
        },
    };

    public static TheoryData<string> Bodies => new(
        "status.js", "list-documents.js", "inspect-document.js", "preflight.js",
        "restored-paths.js", "audit-document.js", "close-document.js", "open-document.js", "create-document.js",
        "export-document.js", "save-document.js", "execute-document.js", "run-layout-script.js", "restore-backup.js");

    private static string Render(string template)
    {
        var inputs = SampleInputs(template);
        if (template == "export-document.js")
        {
            string actions = string.Join("\n", new[] { "export-pdf-action.js", "export-png-action.js", "export-idml-action.js", "package-action.js" }
                .Select(action => "  {\n" + UxpTemplates.Render(action, inputs).TrimEnd('\n') + "\n  }"));
            inputs["exportAction"] = actions;
        }
        string body = UxpTemplates.Render(template, inputs);
        bool sync = template is "status.js" or "list-documents.js" or "inspect-document.js" or "preflight.js";
        return sync ? UxpTemplates.SyncScript(body) : UxpTemplates.AsyncScript(body, @"C:\r\result.json", 4_194_304, Guid.NewGuid().ToString("D"));
    }

    [Theory]
    [MemberData(nameof(Bodies))]
    public void Every_UXP_script_renders_completely(string template)
    {
        string script = Render(template);
        Assert.DoesNotContain("@@", script);
        Assert.Contains("documentStateToken", script);
    }

    [Fact]
    public void Generated_scripts_parse_as_JavaScript()
    {
        string node = FindNode();
        string folder = Path.Combine(Path.GetTempPath(), "nexusindesign-syntax", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var files = new List<string>();
            foreach (var row in Bodies)
            {
                string template = (string)row.Data;
                string script = Render(template);
                bool sync = template is "status.js" or "list-documents.js" or "inspect-document.js" or "preflight.js";
                // Asynchronous scripts use top-level await (UXP); a synchronous one must not, DoScript has no module context.
                string wrapped = sync ? script : "(async () => {\n" + script + "\n})();\n";
                string file = Path.Combine(folder, template);
                File.WriteAllText(file, wrapped);
                files.Add(file);
            }
            string backup = Path.Combine(folder, "create-backup.jsx.js");
            File.WriteAllText(backup, UxpTemplates.Render("create-backup.jsx", SampleInputs("create-backup.jsx")));
            files.Add(backup);
            foreach (string file in files)
            {
                using var process = Process.Start(new ProcessStartInfo(node, $"--check \"{file}\"") { RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true })!;
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                Assert.True(process.ExitCode == 0, $"{Path.GetFileName(file)}: {error}");
            }
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    private static string FindNode()
    {
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            string candidate = Path.Combine(directory.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        throw new InvalidOperationException("node.exe is needed to check the generated UXP scripts (test only).");
    }

    [Fact]
    public void A_missing_template_input_refuses_the_script()
    {
        var error = Assert.Throws<ToolError>(() => UxpTemplates.Render("inspect-document.js", new Dictionary<string, string>()));
        Assert.Equal("GENERATED_UXP_INPUT_MISSING", error.Code);
    }

    [Fact]
    public void Literals_escape_line_separators_for_JavaScript()
    {
        Assert.Equal("\"a\\u2028b\"", Json.Literal("a\u2028b"));
        Assert.Equal("null", Json.Literal(null));
        Assert.Equal("{\"x\":[1,true]}", Json.Literal(new JsonObject { ["x"] = new JsonArray(1, true) }));
    }
}
