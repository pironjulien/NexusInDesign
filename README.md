# NexusInDesign

Adobe InDesign for Claude Code and Codex. One native Windows engine (`NexusInDesign.exe`, C#, self-contained) drives
InDesign 2024 to 2026 **through its COM automation only**: UXP scripts run by `DoScript` under `NEVER_INTERACT`. No
panel, no Adobe UXP plugin, no Node.js, no network listener, no Computer Use. Every change is checked against the
document's revision and state token, every open document is backed up first, and every exported file is verified.

## Install

The usual way is the NexusSystem app (Microsoft Store): it runs this product's `get.ps1` and adds the
`nexus-indesign` plugin to Claude Code and Codex from the Nexus catalog.

By hand: download `get.ps1` and `SHA256SUMS.txt` from the [latest release](https://github.com/pironjulien/NexusInDesign/releases/latest),
check the hash (and `gh attestation verify get.ps1 --repo pironjulien/NexusInDesign`), then run the file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1
```

It installs `%USERPROFILE%\.nexus\nexus-indesign\NexusInDesign.exe` (no administrator rights), the path both plugins
start. Run it again to update; `-Remove` removes the program and keeps backups and the audit journal. Claude Desktop
can also use the MCP bundle (`nexus-indesign-<version>-win-x64.mcpb` or `-win-arm64.mcpb`) of each release.

InDesign must be installed (it registers its COM server); the engine starts it when needed and closes it again if it
started it hidden and nothing stays open.

## How agents work with it

The `nexus-indesign` skill (in `plugin/skills`) guides the agent:

1. `silent_status`, `silent_list_documents`, then `open_document` or `create_document`: each returns `documentId`,
   `revision` and `stateToken`.
2. **`run_layout_script`** for every coherent change: in one tracked InDesign pass it checks revision and state token,
   backs up every open document (restorable with `silent_restore_backup`), runs the UXP script (`app`, `indesign`,
   `doc`, `input`), saves if asked, renders a verified PNG preview and optionally closes. It returns the new revision
   and token, so calls chain without re-inspection; a failing script is a known outcome with its backup.
3. `preflight_document`, then `finalize_layout` (PDF only if the layout contract and Adobe's preflight pass) or
   `export_pdf`, `export_png`, `export_idml`, `package_document`, `save_document`, `save_as`.
4. `silent_close_document` for the documents the task opened.

Other tools: `analyze_layout` and `compare_layout_snapshot` (geometry, resources, styles, lint and a stable layout
fingerprint), `preview_layout`, `create_working_copy`, `silent_audit_document` and the `get_*` reads,
`execute_uxp_silent`, `indesign_doctor` (local checks, never starts InDesign) and `search_official_dom` (offline index
of Adobe's official DOM reference, pinned by SHA-256). 32 tools in all.

After a timeout or a crash, `silent_operation_status` tells what is known; every InDesign command stays refused until
`silent_reconcile_unknown_operation` has proven the documents stable and backed them up (it asks for a full InDesign
restart when the interrupted script could still resume).

## Settings

Defaults suit most users: documents are read from and written to the user profile; private storage, `~\.nexus`,
`.ssh`, `.gnupg` and AppData are denied. To change the roots, create
`%USERPROFILE%\.nexus\nexus-indesign\settings.json`:

```json
{
  "readRoots": ["C:\\Dev", "%USERPROFILE%\\Documents"],
  "writeRoots": ["C:\\Dev", "%USERPROFILE%\\Documents"],
  "deniedRoots": ["%USERPROFILE%\\Documents\\Secrets"]
}
```

Environment variables take precedence: `INDESIGN_MCP_READ_ROOTS`, `INDESIGN_MCP_WRITE_ROOTS`,
`INDESIGN_MCP_DENIED_ROOTS` (`;`-separated), `INDESIGN_MCP_COMMAND_TIMEOUT_MS` (default 120000),
`INDESIGN_MCP_BACKUP_MAX_AGE_HOURS` (24), `INDESIGN_MCP_BACKUP_MAX_FILES` (200), `INDESIGN_MCP_ALLOWED_PARENT_*`.

## Privacy

Everything stays on the PC. The engine sends nothing over the network; backups, the audit journal (no document text,
no path, no code) and the runtime stay in `%USERPROFILE%\.nexus\nexus-indesign\private`, readable by the current user
only. See [SECURITY.md](SECURITY.md) for the trust boundary and the safeguards.

## Build and test

```powershell
.\test.ps1
pwsh -File tools/package.ps1 -Version 4.1.4
```

`test.ps1` runs the xUnit suite against an emulated InDesign (no InDesign needed). Every push to `main` builds and
attests the release files through NexusSystem's shared workflows; a new version is promoted to a stable release with the
same files. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

MIT (see [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
