# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [4.1.4] - 2026-11-04

### Changed
- Display name written NexusInDesign, without a space, like the repository and the NexusSystem catalog.

## [4.1.3] - 2026-11-04

### Changed
- Product icon now shows the julienpiron.fr medallion on a transparent background at every size (no dark square), with the knot badge at the bottom of the ring kept whole.
- Same `.gitattributes` as every Nexus repository (2026-11-04): LF in Git and on disk, CRLF only for `.cmd`/`.bat`; files stored with CRLF were renormalized once. `CLAUDE.md` imports `AGENTS.md`, so Claude reads the same project rules as Codex and Antigravity.
- `native/reference/indesign-dom-paths.xml` is stored byte-exact (`-text`, CRLF as published by Adobe) so its pinned SHA-256 matches on every checkout; the shared `.gitattributes` had made CI check it out with LF.

## [4.1.2] - 2026-11-03

### Fixed
- MCP clients receive numeric item schemas for document margins and bleed instead of homogeneous tuples that
  could be misread as strings. All four nonnegative values remain mandatory.
- Public script and PNG-export argument schemas expose their object properties directly. Conditional combinations
  remain validated with the complete server schema, including the requirement to save before closing.
- Creating an INDD in a missing parent folder fails before reaching InDesign, without leaving an unsaved document
  or a durable mutation lease that would require reconciliation.

## [4.1.1] - 2026-11-02

### Fixed
- Use valid YAML for the InDesign skill description without changing its text or instructions.

## [4.1.0] - 2026-10-31

### Added
- One-step undo: the synchronous part of a `run_layout_script` or `execute_uxp_silent` script (everything before its
  first `await`) runs in a named `doScript` with `UndoModes.ENTIRE_SCRIPT` ("Nexus : <reason>"), and the revision label
  joins that step (`AUTO_UNDO`): one `undo()` removes the script's changes, a failed script's partial changes included.
  The result reports `undo.name` and `undo.singleStep`. (A COM-level `DoScript` undo mode does not group asynchronous
  UXP scripts; checked in InDesign 2026.)
- `run_layout_script` and `preview_layout` return capped thumbnails (JPEG, longest side 1024 px, 4 pages at most) as
  MCP image content next to the PNG paths, with a `thumbnails` summary.
- `preview_layout` `annotate: true`: the preview is rendered from a hidden private copy of the document (its safety
  backup, opened without a window and closed unsaved) carrying an annotation layer: margins, column gutters, each
  item's outline and `#id`, overset text in red. The source stays unchanged (fingerprint checked before and after).
- `analyze_layout` read-only typographic audit (warnings, never blocking): `STYLE_OVERRIDE`, `UNSTYLED_TEXT`,
  `INCONSISTENT_POINT_SIZE`, `INCONSISTENT_LEADING`, `LEADING_TIGHTER_THAN_SIZE`, with the stories to fix; the snapshot
  gains a `typography` section (paragraphs grouped by style, no text).
- Skill recipes tested in InDesign 2026: fill `{{fields}}` and list the remaining ones, chain pages until no overset
  text, relink missing links by file name.

### Changed
- Every failed call returns structured content in the convention shared with NexusBrowser: `code`, `outcome`
  (`not_done`, `unknown`, `partial`), `retry_safe` and, when one unblocks the agent, `nextTool` (stale token →
  `silent_inspect_document`, unknown outcome → `silent_operation_status`). A failed `run_layout_script` script reports
  `outcome` `partial` when it changed the document, `not_done` otherwise.

## [4.0.2] - 2026-10-31

### Fixed
- Codex desktop can start the engine from its official versioned `%LOCALAPPDATA%\OpenAI\Codex\bin` folder.
  The exact `codex.exe` name and a valid OpenAI Authenticode signature remain required; explicit allowed-parent
  paths still replace the defaults.

## [4.0.1] - 2026-10-31

### Changed
- The skill is named after its plugin (`nexus-indesign`, formerly `indesign-studio`) and both plugin manifests carry
  the same description, as the Nexus catalog requires for every plugin.

## [4.0.0] - 2026-10-31

NexusInDesign is now a native Windows engine in C#: it drives InDesign only through its COM automation (`DoScript`
with UXP scripts under `NEVER_INTERACT`), without Node.js, without the Adobe UXP plugin (`.ccx`) and without any network
listener, so NexusSystem can install it like the other Nexus products.

### Added
- Native engine `NexusInDesign.exe` (.NET 10, self-contained single file, x64 and Arm64): MCP over stdio, the 32-tool
  `core` profile, JSON Schema 2020-12 argument checks, the same path policy, backups, revision and `stateToken` checks,
  audit journal and recovery as before. COM runs in-process on one STA thread that owns the shared mutex
  `Local\NexusInDesignAutomation`: no PowerShell per call.
- Silent `save_document`, `save_as`, `export_idml` and `create_working_copy` (they needed the UXP panel before):
  backups of every open document first, the other documents checked unchanged, the saved INDD or exported IDML
  structurally verified.
- `get.ps1`: installs or updates `%USERPROFILE%\.nexus\nexus-indesign\NexusInDesign.exe` from the latest release after
  checking its SHA-256 (attested build); `-Remove` removes it and keeps backups and the audit journal.
- `plugin/`: the Claude Code and Codex plugins (manifests, MCP declarations, the `indesign-studio` skill), pinned in the
  Nexus catalog; MCP bundles (`.mcpb`, x64 and Arm64) for Claude Desktop, listed in the official MCP registry.
- Optional `%USERPROFILE%\.nexus\nexus-indesign\settings.json` (`readRoots`, `writeRoots`, `deniedRoots`), next to the
  `INDESIGN_MCP_*` environment variables.
- `Release` workflow through NexusSystem's shared `product-dev-release` and `product-promote` (Sigstore build
  provenance, the same files promoted to stable); `Tests` runs `test.ps1` (xUnit: the engine against an emulated
  InDesign, the COM host's mutex, the syntax of every generated UXP script, `get.ps1`).
- Public repository `pironjulien/NexusInDesign` (2026-10-31) started from a clean history; `Security` workflow
  (gitleaks, zizmor) on every push; Dependabot for GitHub Actions and NuGet with a 7-day cooldown.
- `run_layout_script`: one tracked InDesign pass that checks `revision` and `stateToken`, backs up every open
  document, runs the UXP script, saves, renders a verified PNG preview and returns the new revision and token.
- Claude Code as an allowed caller next to Codex (executable name, folder and Authenticode signer checked).

### Changed
- Private storage moves to `%USERPROFILE%\.nexus\nexus-indesign\private` (backups, audit, runtime), still refused
  under OneDrive; default read and write root: the user profile; `.nexus`, `.ssh`, `.gnupg` and AppData are denied.
- An unknown outcome left by this server can be reconciled once its InDesign call has ended (before, only one left by
  a crashed server); an InDesign started by a call that ends hidden with no document is closed again.
- Default command timeout 120 s (`INDESIGN_MCP_COMMAND_TIMEOUT_MS`, up to 600 s).

### Removed
- The Node.js server, its npm dependencies and `install.ps1` (runtime in `~\.nexus\indesign-mcp-secure`).
- The Adobe UXP plugin (`.ccx`), its WebSocket listener on `127.0.0.1:33171`, pairing, HMAC token and shared broker,
  with the tools that only it served: `bridge_status`, `bridge_open_pairing_window`, `bridge_arm_pairing_clipboard`,
  `bridge_operation_status`, `execute_uxp` (use `execute_uxp_silent`), `restore_safety_backup` (use
  `silent_restore_backup`), `close_document` (use `silent_close_document` or `run_layout_script` with `close`),
  `list_documents` (use `silent_list_documents`) and `ping`.
- The `full` profile (131 historical object-by-object commands, all served by the UXP plugin): write them as a UXP
  script passed to `run_layout_script`.
- The PowerShell COM launchers and mutex helper (`scripts\`).

### Security
- No network listener at all; nothing but the agent's stdio reaches the engine.
- The parent chain is read natively (process snapshot, image paths, start times against PID reuse) and signatures are
  checked with WinVerifyTrust.

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
