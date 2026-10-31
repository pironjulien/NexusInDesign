using System.Text.Json.Nodes;

namespace NexusInDesign.Tests;

/// <summary>The tools end to end against an emulated InDesign: state chaining, backups, verified exports, recovery.</summary>
public sealed class SilentFlowTests
{
    private static async Task<(JsonObject Opened, string Source)> OpenSample(Sandbox sandbox, string name = "brochure.indd")
    {
        string source = sandbox.Path(name);
        Samples.WriteIndd(source, "source");
        var opened = await sandbox.Ok("open_document", new JsonObject { ["expectedRevision"] = 0, ["path"] = source });
        return (opened, source);
    }

    private static JsonObject State(JsonObject from, string reason = "Mise en page de la brochure") => new()
    {
        ["documentId"] = from["documentId"]!.DeepClone(),
        ["expectedRevision"] = from["revision"]!.DeepClone(),
        ["expectedStateToken"] = from["stateToken"]!.DeepClone(),
        ["reason"] = reason,
    };

    [Fact]
    public async Task Open_script_export_and_close_chain_revision_and_state_token()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        Assert.Equal(0, Json.Long(opened, "revision"));
        Assert.Equal("indd", Json.Str(opened["artifactVerification"], "kind"));

        var script = State(opened);
        script["code"] = "doc.pages.item(0).textFrames.add();";
        script["save"] = true;
        var response = await sandbox.Call("run_layout_script", script);
        var layout = (JsonObject)response["structuredContent"]!;
        Assert.True(Json.IsTrue(layout, "scriptOk"));
        // The preview comes back as a capped JPEG thumbnail next to its PNG path.
        var thumbnail = (JsonObject)response["content"]![1]!;
        Assert.Equal("image", Json.Str(thumbnail, "type"));
        Assert.Equal("image/jpeg", Json.Str(thumbnail, "mimeType"));
        Assert.True(Convert.FromBase64String(Json.Str(thumbnail, "data")!).Length > 0);
        Assert.Equal(1, Json.Long(layout["thumbnails"], "returned"));
        Assert.Equal(1, Json.Long(layout, "revision"));
        Assert.True(Json.IsTrue(layout, "saved"));
        Assert.Single((JsonArray)layout["previewPaths"]!);
        var backup = Assert.Single((JsonArray)layout["safetyBackups"]!)!;
        Assert.True(File.Exists(Json.Str(backup, "backupPath")));
        Assert.True(File.Exists(Json.Str(backup, "metadataPath")));

        var export = State(layout);
        export["filePath"] = sandbox.Path("out/brochure.pdf");
        var pdf = await sandbox.Ok("export_pdf", export);
        Assert.Equal("pdf", Json.Str(pdf["artifactVerification"], "kind"));
        Assert.Equal("silent", Json.Str(pdf, "executionChannel"));
        Assert.NotNull(Json.Str(pdf, "backupId"));

        var close = State(pdf, "Fermer le document fini");
        close["save"] = false;
        var closed = await sandbox.Ok("silent_close_document", close);
        Assert.Equal(Json.Long(opened, "documentId"), Json.Long(closed, "closedDocumentId"));
        Assert.Empty(sandbox.InDesign.Documents);
        Assert.False(File.Exists(sandbox.App.Bridge!.LeasePath));
        Assert.Equal(0, sandbox.InDesign.ActiveHolds);
    }

    [Fact]
    public async Task A_stale_state_token_is_refused_without_leaving_a_lease()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var stale = State(opened);
        stale["expectedStateToken"] = "0123456789abcdef";
        stale["code"] = "return 1;";
        var refused = (JsonObject)(await sandbox.Call("run_layout_script", stale))["structuredContent"]!;
        Assert.Equal("STATE_CONFLICT", Json.Str(refused, "code"));
        Assert.Equal("not_done", Json.Str(refused, "outcome"));
        Assert.True(Json.IsTrue(refused, "retry_safe"));
        Assert.Equal("silent_inspect_document", Json.Str(refused, "nextTool"));
        Assert.False(File.Exists(sandbox.App.Bridge!.LeasePath));

        var export = State(opened);
        export["expectedRevision"] = 7;
        export["filePath"] = sandbox.Path("stale.pdf");
        Assert.Contains("REVISION_CONFLICT", await sandbox.Fails("export_pdf", export));
        Assert.False(File.Exists(sandbox.Path("stale.pdf")));
    }

    [Fact]
    public async Task A_failing_script_is_a_known_outcome_with_its_backup()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var script = State(opened);
        script["code"] = "throw new Error('boom');";
        var result = await sandbox.Ok("run_layout_script", script);
        Assert.False(Json.IsTrue(result, "scriptOk"));
        Assert.NotNull(Json.Str(result, "backupId"));
        Assert.Contains("silent_restore_backup", Json.Str(result, "nextStep"));
        Assert.Equal("not_done", Json.Str(result, "outcome"));
        Assert.True(Json.IsTrue(result, "retry_safe"));
        Assert.False(File.Exists(sandbox.App.Bridge!.LeasePath));
    }

    [Fact]
    public async Task An_unknown_outcome_blocks_everything_until_InDesign_restarted_and_reconciled()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        sandbox.InDesign.LoseResultOf = "run-layout-script.js";
        var script = State(opened);
        script["code"] = "doc.pages.add();";
        var response = await sandbox.Call("run_layout_script", script);
        Assert.True(Json.IsTrue(response, "isError"));
        var recovery = (JsonObject)response["structuredContent"]!;
        Assert.True(Json.IsTrue(recovery, "requiresInspection"));
        Assert.Equal("unknown", Json.Str(recovery, "outcome"));
        Assert.False(Json.IsTrue(recovery, "retry_safe"));
        Assert.Equal("silent_operation_status", Json.Str(recovery, "nextTool"));
        string operationId = Json.Str(recovery, "operationId")!;
        Assert.True(File.Exists(sandbox.App.Bridge!.LeasePath));

        var status = await sandbox.Ok("silent_operation_status", new JsonObject { ["operationId"] = operationId });
        Assert.Equal("pending", Json.Str(status, "status"));
        Assert.Contains("MUTATION_IN_PROGRESS", await sandbox.Fails("silent_list_documents"));
        var health = await sandbox.Ok("silent_status");
        Assert.False(Json.IsTrue(health, "available"));

        var reconcile = new JsonObject { ["operationId"] = operationId, ["reason"] = "Le script a dépassé son délai" };
        Assert.Contains("RECONCILIATION_RESTART_REQUIRED", await sandbox.Fails("silent_reconcile_unknown_operation", reconcile));

        sandbox.InDesign.Hosts.Clear();
        sandbox.InDesign.Hosts.Add(new InDesign.HostProcess(5151, DateTime.UtcNow, true));
        var reconciled = await sandbox.Ok("silent_reconcile_unknown_operation", reconcile);
        Assert.Equal("reconciled-unknown", Json.Str(reconciled, "status"));
        Assert.NotEmpty((JsonArray)reconciled["safetyBackups"]!);
        Assert.False(File.Exists(sandbox.App.Bridge.LeasePath));
        var after = await sandbox.Ok("silent_operation_status", new JsonObject { ["operationId"] = operationId });
        Assert.Equal("reconciled-unknown", Json.Str(after, "status"));
        Assert.False(Json.IsTrue(after, "requiresReconciliation"));
        await sandbox.Ok("silent_list_documents");
    }

    [Fact]
    public async Task A_lease_left_by_a_dead_server_with_a_completed_result_is_released()
    {
        using var sandbox = new Sandbox();
        var bridge = sandbox.App.Bridge!;
        string operationId = Guid.NewGuid().ToString("D");
        string sessionId = Guid.NewGuid().ToString("D");
        string session = Path.Combine(bridge.RuntimeRoot, sessionId);
        Directory.CreateDirectory(session);
        File.WriteAllText(Path.Combine(session, $"{operationId}.result.json"), "{\"ok\":true,\"operationId\":\"" + operationId + "\"}");
        File.WriteAllText(bridge.LeasePath, new JsonObject
        {
            ["schemaVersion"] = 1, ["operationId"] = operationId, ["sessionId"] = sessionId, ["kind"] = "silent",
            ["createdAt"] = DateTime.UtcNow.AddMinutes(-5).ToString("o"), ["processId"] = 999_999, ["processStartedAt"] = DateTime.UtcNow.AddHours(-2).ToString("o"),
        }.ToJsonString());
        var (opened, _) = await OpenSample(sandbox);
        Assert.Equal(0, Json.Long(opened, "revision"));
        Assert.False(File.Exists(bridge.LeasePath));
    }

    [Fact]
    public async Task Paths_outside_the_roots_or_in_a_denied_root_are_refused_before_InDesign()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        int runs = sandbox.InDesign.Runs.Count;
        var outside = State(opened);
        outside["filePath"] = Path.Combine(sandbox.Root, "elsewhere.pdf");
        Assert.Contains("PATH_OUTSIDE_ROOTS", await sandbox.Fails("export_pdf", outside));
        var denied = State(opened);
        denied["filePath"] = Path.Combine(sandbox.Secret, "leak.pdf");
        Assert.Contains("PATH_DENIED", await sandbox.Fails("export_pdf", denied));
        var extension = State(opened);
        extension["filePath"] = sandbox.Path("wrong.txt");
        Assert.Contains("PATH_EXTENSION_DENIED", await sandbox.Fails("export_pdf", extension));
        Assert.Equal(runs, sandbox.InDesign.Runs.Count);
        string junction = sandbox.Path("link");
        EngineUnitTests.Junction(junction, sandbox.Secret);
        var escape = State(opened);
        escape["filePath"] = Path.Combine(junction, "escape.pdf");
        Assert.Contains("PATH_DENIED", await sandbox.Fails("export_pdf", escape));
    }

    [Fact]
    public async Task An_existing_target_is_replaced_only_with_overwrite_after_a_private_copy()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        string target = sandbox.Path("final.pdf");
        File.WriteAllText(target, "previous");
        var export = State(opened);
        export["filePath"] = target;
        Assert.Contains("TARGET_EXISTS", await sandbox.Fails("export_pdf", export));
        export["overwrite"] = true;
        var pdf = await sandbox.Ok("export_pdf", export);
        string copy = Json.Str(pdf, "targetBackupPath")!;
        Assert.Equal("previous", File.ReadAllText(copy));
        Assert.StartsWith(sandbox.Config.BackupRoot, copy);
    }

    [Fact]
    public async Task Multipage_png_idml_and_package_exports_are_verified()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var png = State(opened);
        png["folderPath"] = sandbox.Path("previews");
        png["resolution"] = 72;
        var pages = await sandbox.Ok("export_png", png);
        Assert.Equal(2, ((JsonArray)pages["paths"]!).Count);
        Assert.Equal("multipage-png", Json.Str(pages["artifactVerification"], "kind"));

        var idml = State(pages);
        idml["filePath"] = sandbox.Path("brochure.idml");
        var markup = await sandbox.Ok("export_idml", idml);
        Assert.Equal("idml", Json.Str(markup["artifactVerification"], "kind"));

        var package = State(markup);
        package["folderPath"] = sandbox.Path("package");
        var assembled = await sandbox.Ok("package_document", package);
        Assert.Equal("package", Json.Str(assembled["artifactVerification"], "kind"));
    }

    [Fact]
    public async Task Save_as_then_save_document_return_the_new_state()
    {
        using var sandbox = new Sandbox();
        var created = await sandbox.Ok("create_document", new JsonObject { ["expectedRevision"] = 0, ["width"] = 210, ["height"] = 297 });
        var unsaved = State(created);
        Assert.Contains("SAVE_AS_REQUIRED", await sandbox.Fails("save_document", unsaved));
        var saveAs = State(created);
        saveAs["path"] = sandbox.Path("nouveau.indd");
        var saved = await sandbox.Ok("save_as", saveAs);
        Assert.Equal("indd", Json.Str(saved["artifactVerification"], "kind"));
        Assert.NotEqual(Json.Str(created, "stateToken"), Json.Str(saved, "stateToken"));
        var again = await sandbox.Ok("save_document", State(saved));
        Assert.Equal(Json.Str(saved, "stateToken"), Json.Str(again, "stateToken"));
    }

    [Fact]
    public async Task Create_document_with_a_path_refuses_to_overwrite()
    {
        using var sandbox = new Sandbox();
        string path = sandbox.Path("existant.indd");
        Samples.WriteIndd(path);
        Assert.Contains("TARGET_EXISTS", await sandbox.Fails("create_document", new JsonObject { ["expectedRevision"] = 0, ["width"] = 100, ["height"] = 100, ["path"] = path }));
        var created = await sandbox.Ok("create_document", new JsonObject { ["expectedRevision"] = 0, ["width"] = 100, ["height"] = 100, ["path"] = sandbox.Path("neuf.indd") });
        Assert.True(Json.IsTrue(created, "saved"));
        Assert.Equal("indd", Json.Str(created["artifactVerification"], "kind"));
    }

    [Fact]
    public async Task Restore_backup_replaces_the_document_and_keeps_a_recovery_copy()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var script = State(opened);
        script["code"] = "doc.pages.add();";
        var layout = await sandbox.Ok("run_layout_script", script);
        var restore = State(layout, "Revenir à la version d’avant");
        restore["backupId"] = Json.Str(layout, "backupId");
        var restored = await sandbox.Ok("silent_restore_backup", restore);
        Assert.Equal(Json.Long(layout, "revision") + 1, Json.Long(restored, "revision"));
        Assert.NotEmpty((JsonArray)restored["recoveryBackups"]!);
        Assert.True(File.Exists(Json.Str(restored, "restoredWorkingPath")));
    }

    [Fact]
    public async Task A_backup_whose_file_changed_is_refused()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var script = State(opened);
        script["code"] = "doc.pages.add();";
        var layout = await sandbox.Ok("run_layout_script", script);
        string backupPath = Json.Str(((JsonArray)layout["safetyBackups"]!)[0], "backupPath")!;
        Samples.WriteIndd(backupPath, "tampered");
        var restore = State(layout, "Revenir à la version d’avant");
        restore["backupId"] = Json.Str(layout, "backupId");
        Assert.Contains("BACKUP_INTEGRITY_FAILED", await sandbox.Fails("silent_restore_backup", restore));
    }

    [Fact]
    public async Task Working_copy_opens_a_verified_copy_and_leaves_the_source_unchanged()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var copy = State(opened);
        copy["path"] = sandbox.Path("copie.indd");
        var result = await sandbox.Ok("create_working_copy", copy);
        Assert.True(Json.IsTrue(result, "sourceUnchanged"));
        Assert.NotEqual(Json.Long(opened, "documentId"), Json.Long(result, "workingDocumentId"));
        Assert.True(File.Exists(sandbox.Path("copie.indd")));
        Assert.Equal(2, sandbox.InDesign.Documents.Count);
    }

    [Fact]
    public async Task Execute_uxp_silent_backs_up_and_advances_revisions()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var call = State(opened);
        call["code"] = "return 42;";
        var result = await sandbox.Ok("execute_uxp_silent", call);
        Assert.Equal(42, Json.Long(result, "result"));
        Assert.Equal(1, Json.Long(result, "revision"));
        Assert.NotEmpty((JsonArray)result["safetyBackups"]!);
    }

    [Fact]
    public async Task Reads_analysis_and_finalize_gates()
    {
        using var sandbox = new Sandbox();
        var (opened, _) = await OpenSample(sandbox);
        var id = new JsonObject { ["documentId"] = opened["documentId"]!.DeepClone() };
        Assert.Equal(2, Json.Long((await sandbox.Ok("get_document_info", id))["document"], "pages"));
        Assert.Equal(2, ((JsonArray)(await sandbox.Ok("list_pages", (JsonObject)id.DeepClone()))["pages"]!).Count);
        var audit = await sandbox.Ok("silent_audit_document", (JsonObject)id.DeepClone());
        Assert.Equal(Json.Str(opened, "stateToken"), Json.Str(audit, "stateToken"));
        var analysis = await sandbox.Ok("analyze_layout", (JsonObject)id.DeepClone());
        string fingerprint = Json.Str(analysis, "fingerprint")!;
        var compare = (JsonObject)id.DeepClone();
        compare["baselineFingerprint"] = fingerprint;
        Assert.True(Json.IsTrue(await sandbox.Ok("compare_layout_snapshot", compare), "matches"));

        sandbox.InDesign.PreflightFindings = [new JsonArray("Texte en excès")];
        var finalize = State(opened);
        finalize["filePath"] = sandbox.Path("final.pdf");
        var gated = await sandbox.Ok("finalize_layout", finalize);
        Assert.False(Json.IsTrue(gated, "exported"));
        Assert.Equal("adobe-preflight", Json.Str(gated, "gate"));
        sandbox.InDesign.PreflightFindings = null;
        var passed = await sandbox.Ok("finalize_layout", finalize);
        Assert.True(Json.IsTrue(passed, "exported"));
        Assert.Equal("pdf", Json.Str(passed["pdf"]?["artifactVerification"], "kind"));
    }

    [Fact]
    public async Task The_audit_journal_keeps_no_reason_text_nor_path()
    {
        using var sandbox = new Sandbox();
        var (opened, source) = await OpenSample(sandbox);
        var script = State(opened, "Raison très confidentielle 1234");
        script["code"] = "doc.pages.add();";
        await sandbox.Ok("run_layout_script", script);
        string journal = File.ReadAllText(sandbox.Config.AuditFile);
        Assert.DoesNotContain("confidentielle", journal);
        Assert.DoesNotContain(Path.GetFileName(source), journal);
        Assert.Contains("reasonHash", journal);
        Assert.Contains("\"outcome\":\"success\"", journal);
    }
}
