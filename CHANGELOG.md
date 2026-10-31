# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Public repository `pironjulien/NexusInDesign` (2026-10-31), started from a clean history; the earlier private
  development history is not published.
- `Security` workflow on every push and pull request: gitleaks over the whole history and zizmor workflow audit;
  `Tests` workflow (Windows, `npm test` and `npm audit`) on every push to main and every pull request;
  actions pinned by commit SHA, Dependabot for GitHub Actions and npm with a 7-day cooldown.
- Codex plugin icons: original Nexus InDesign pictogram, 64 and 512 px PNG for `composerIcon` and `logo`.
- `run_layout_script` tool (`core` profile): one tracked InDesign pass that checks `revision` and `stateToken`,
  backs up every open document, runs the UXP script, saves, renders a verified PNG preview and returns the new
  revision and token.
- Tool profiles (`INDESIGN_MCP_TOOL_PROFILE`): `core` by default (41 tools), `full` (172 tools) restores the
  historical `legacy-uxp` commands. A hidden tool is neither listed nor callable; `indesign_doctor` shows the profile.
- Claude Code as an allowed caller, next to Codex (parent executable name, folder and signature checked).
- `create_document` and `package_document` go through the silent channel (COM + UXP, `NEVER_INTERACT`) when the UXP
  panel is not connected; an InDesign packaging refusal is explained (RGB images, links, missing fonts, overset).
- Shared local broker: the first server that binds `127.0.0.1:33171` serves the other agent tasks; peers
  authenticate mutually and the owner checks each client's signed agent process chain.
- `scripts\Install-Workstation.ps1` (multi-PC setup from the verified release) and `install.ps1` (runtime in
  `~\.nexus\indesign-mcp-secure`, outside OneDrive, with locked dependencies; `-CheckOnly` to verify).
- `test.ps1` at the root: `npm test` in a mirror copy outside OneDrive, then gitleaks, without InDesign.

### Changed
- The Windows named mutex shared by the plugin and silent channels is now `Local\NexusInDesignAutomation`
  (test mutexes: `Local\NexusInDesignAutomation.Test.<uuid>`). Reinstall the runtime with `install.ps1` so the
  server and the scripts use the same name.
- The release manifest `release\v3.2.2.json` points at `pironjulien/NexusInDesign`.
- The version is read from `package.json` instead of being hard-coded.
- The private vault only keeps the pairing token; backups, audit and execution state live in
  `~\.nexus\indesign-mcp-secure\private`, outside OneDrive.
- `export_pdf`, `export_png`, `preview_layout` and `finalize_layout` prefer the silent channel; COM launcher
  measured from 6.2 s to 1.2 s.
- Dependencies: MCP SDK 1.32.2 (2026-10-31), ws 8.22.0, zod 4.6.7.

### Fixed
- The MCP protocol test compares the packaging folder after canonical resolution, so it passes on Windows runners
  whose temporary folder is a short 8.3 path (`RUNNER~1`).

### Removed
- Direct registration through `codex mcp add` (`Install-CodexMcp.ps1`, `Start-SecurePairing.ps1`,
  `Set-CodexMcpPolicy.mjs`): the Codex and Claude plugins declare the server.

### Known issues
- `silent_close_document` on a packaged copy can stop the server.
- The first `export_pdf` after a heavy build can see the document state change during the export.

## [3.2.2] - 2026-07-17

### Fixed
- Asynchronous advanced UXP execution, silent channel with several open documents, modern and legacy image exports.

### Added
- Official Adobe CCX 3.2.2, verified on its eight files, SHA-256 and logical fingerprint against the sources.

## [3.2.1] - 2026-07-16

### Fixed
- Persistent UXP connection compatible with InDesign 21.4, with a visible connection diagnostic.

## [3.2.0] - 2026-07-15

### Added
- The 112 historical UXP commands back inside the secured workflow, with exact document targeting.
- A Windows mutex shared by the plugin and silent channels, held by an independent helper until a signed
  acknowledgement.
- Editorial art-direction recipes in the `indesign-studio` skill.

## [3.1.0] - 2026-07-15

### Added
- Codex plugin source with the `indesign-studio` skill; deterministic reference archive next to the official CCX.
- Silent channel: synchronous or asynchronous UXP, `stateToken`, backups of every open document before free code,
  `silent_operation_status`, `silent_reconcile_unknown_operation`, `silent_restore_backup`,
  `silent_audit_document`, `silent_close_document`; `indesign_doctor` and an offline index of the Adobe DOM.

### Changed
- UXP network permission reduced to `ws://127.0.0.1:33171`; InDesign 19.0 minimum.

## [3.0.0] - 2026-07-13

### Added
- Fork of `theloniuser/indesign-uxp-server`: a single authenticated MCP/WebSocket server launched only from an
  allowed agent process chain, mutual HMAC authentication, path policy, mandatory backups with bounded retention,
  controlled restore and a real InDesign end-to-end test.

### Removed
- The former HTTP server and declarative tests.
