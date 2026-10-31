# Nexus InDesign

A bridge between Codex or Claude Code and Adobe InDesign. It combines a silent UXP
channel, an authenticated UXP plugin and controlled layout workflows, with no
public HTTP and no Computer Use during normal InDesign work.

## Architecture: skill, plugin and MCP

```text
Skill InDesign Studio ── guides Codex: inspect, protect, create, critique
          │
Plugin Codex Nexus InDesign ── ships the skill + the MCP configuration
          │
Signed Codex ── MCP STDIO ── Node server ── shared queue ─┬─ local COM ── silent UXP
                                                          └─ WebSocket HMAC ── extension UXP
```

The Node server listens on loopback only for the plugin; the plugin is the
WebSocket client. The two channels start independently.

| Layer | Role | What it does not do |
|---|---|---|
| Skill `indesign-studio` | enforces the workflow, art direction, evidence and rollback | does not communicate directly with InDesign |
| Codex plugin `nexus-indesign` | distributes the skill and the MCP server configuration together | does not run the Adobe DOM itself |
| Local MCP | exposes the tools, checks paths, revisions, backups and results | does not replace the extension loaded in InDesign for the plugin channel |
| UXP extension | runs the authorized commands in the InDesign DOM | its panel is not where Codex does its work |

- two tool profiles, chosen with `INDESIGN_MCP_TOOL_PROFILE`:
  - `core` (default, 41 tools): silent channel, `run_layout_script`, saved UXP
    code (`execute_uxp_silent`, `execute_uxp`), layout workflows (preview,
    preflight, finalize), save, exports and restore;
  - `full` (172 tools): adds the historical one-object commands (`legacy-uxp`
    112, `legacy-local` 3, remaining `direct` ones), for compatibility only;
- a hidden tool is not listed and its call is refused as unknown;
- synchronous or asynchronous UXP JavaScript awaited until a private result;
- syntax of the generated UXP script checked before anything is sent to InDesign;
- mutual HMAC authentication, double nonce, anti-replay and `file://` origin;
- FIFO queue, Windows mutex and persistent cross-process mutation lock;
- `revision` and `stateToken` required for direct mutations, workflows and
  targeted legacy commands, then re-read in InDesign immediately before and
  immediately after the action;
- INDD backups created by the silent channel or the plugin, tied to the
  document, its revision and its fingerprint in a persistent private
  provenance record, then verified by size, signature and SHA-256 before
  restoration;
- recovery for 24 hours of unknown silent and plugin outcomes, including after
  a full MCP restart;
- idempotent server shutdown when STDIO closes or when the identity of its
  parent is lost; a fresh, empty COM host is closed, while an existing
  InDesign instance or one holding documents is preserved and made visible;
- structural verification of PDF, PNG, IDML, INDD and packages;
- overwriting refused by default, with a prior private copy if allowed;
- no code, content, free-form argument, business path or secret in the logs.

## Fast path: `run_layout_script`

One tracked InDesign pass checks `revision` and `stateToken`, backs up every open
document (restorable with `silent_restore_backup`), runs the UXP script, saves
(`save`), renders a verified PNG preview and optionally closes (`close`, only
with `save`). It returns the new revision and state token, so calls chain without
re-inspection. A failing script is a known outcome (`scriptOk: false`, error,
preview, `backupId`) and does not lock the queue.

Latest measurement on InDesign 21.6 for the same A4 page (16 October 2026):
2 calls and 9.3 s, against 10 calls and 56.7 s for the former script path and
20 calls and 140 s for one-object commands (see `CHANGELOG.md`).

## Layout workflows

- `analyze_layout`: geometry, resources, styles, design system, lint and a
  stable SHA-256 fingerprint;
- `compare_layout_snapshot`: round-trip check with a verdict, fingerprints,
  statistics and bounded anomalies, without copying the whole booklet;
- `create_working_copy`: INDD copy opened without modifying the source;
- `preview_layout`: verified multi-page PNGs and source re-read after export;
- `finalize_layout`: PDF export only if the contract and the Adobe preflight
  contain no blocking errors.

`indesign_doctor` checks locally the runtime, the caller policy, the private
storage, the channels and the catalog fingerprint without starting InDesign.
`search_official_dom` searches offline 1,078 references from the official Adobe
DOM, pinned by revision and SHA-256.

## Prerequisites

- Windows 11;
- Adobe InDesign 19.0 minimum, validated on InDesign 2026 `21.6.0.57` (October 2026);
- Node.js 24;
- signed Codex Desktop or Codex CLI;
- GitHub CLI, authenticated (it downloads the release asset);
- OneDrive with `Documents\NexusSecure`;
- Adobe Creative Cloud Desktop, which provides the UPIA installer.

## Full installation on a new workstation

Clone the repository `pironjulien/NexusInDesign` (on Nexus workstations it lives in
`%OneDrive%\Documents\NexusHarness\NexusInDesign`), then run a single command from its root:

```powershell
Set-Location "$env:OneDrive\Documents\NexusHarness\NexusInDesign"
pwsh -NoProfile -File .\scripts\Install-Workstation.ps1
```

The installer fetches the official CCX from the GitHub release of the
current version. It then checks, in turn, the size and SHA-256 anchored in
`release\v3.2.2.json`, the eight internal files and their logical fingerprint
against the Git sources. It therefore rejects a package that is tampered with,
incomplete or from another version.

It then runs `install.ps1`, which copies the runtime and installs the locked
dependencies in `~\.nexus\indesign-mcp-secure`, outside OneDrive, then the Adobe
plugin with UPIA and the Codex plugin with its machine-specific configuration. The private OneDrive
storage is created with a DACL restricted to the current user and `SYSTEM`.
An Adobe installation that is already strictly identical is not repeated. The
full test suite and the npm audit complete the process.

To check only the release without installing anything:

```powershell
pwsh -NoProfile -File .\scripts\Install-Workstation.ps1 -VerifyOnly
```

The first pairing deliberately stays local: after installation, restart
InDesign and open a new Codex task. Codex then opens a time-limited pairing
window and the InDesign panel receives the temporary code. The persistent
secret is never copied by hand or published to Git.

## Synchronization and activation in Codex

The source tracked by Git lives in `codex-plugin`. The personal plugin
**Nexus InDesign** bundles the studio skill and the MCP server configuration,
following the separation recommended by the Codex documentation: the skill
describes the reusable work, the plugin distributes it and the MCP provides
the actual actions.

The skill contains progressive recipes for a magazine, a premium brochure, a
report, a full cover and a catalog. They define a visual direction, sample
pages and critique criteria before rolling out a layout across the whole
document.

Synchronize this source to the personal plugin with:

```powershell
Set-Location "$env:OneDrive\Documents\NexusHarness\NexusInDesign"
.\install.ps1
.\scripts\Sync-CodexPlugin.ps1 -WhatIf
.\scripts\Sync-CodexPlugin.ps1 -Install
.\install.ps1 -CheckOnly
.\scripts\Sync-CodexPlugin.ps1 -CheckOnly -Install
```

The script checks Node.js 24, creates or brings the private storage back into compliance, copies the source into a
staging area under the user profile, generates `.mcp.json` with the real local
paths, then replaces the plugin atomically with rollback. It never writes the
secret value to the repository or the manifest.

The runtime lives in `~\.nexus\indesign-mcp-secure`, outside OneDrive.
`-Install` finds and verifies the signed Desktop backend even without a CLI on PATH,
preserves the personal marketplace's name and other entries, and installs through
Codex's plugin command. The generated version hashes the plugin, machine configuration,
server sources and lock file; it stays stable for identical inputs and changes when
the runtime changes. No separate timestamp cachebuster is needed.

Claude and Codex share `~\.nexus\indesign-mcp-secure\private` and the same authenticated
broker. `-CheckOnly -Install` checks the source and installed cache without modifying them.
Installation alone still proves neither tool exposure nor a working application:
run `indesign_doctor`, `silent_status` and a document qualification after loading the plugin.

## Private storage

Only the pairing secret is synchronized, in
`%OneDrive%\Documents\NexusSecure\InDesignMCP`. Verified backups and the
minimal log stay in `~\.nexus\indesign-mcp-secure\private`, outside OneDrive
and outside Git. The Codex plugin contains only the paths needed to reach these
resources. The vault and the local private storage are explicitly denied to
the structured file tools.

Windows ACLs restrict the storage to the current user and `SYSTEM`. Git, the
application logs and the Codex configuration must contain no secrets, no
document text and no full business path.

## Adobe CCX package 3.2.2

`npm run package:ccx` prepares a minimal eight-file staging area and builds
`dist\fr.pironjulien.indesign.mcp_deterministic-reference.ccx`. This reference
archive is ordered, uses the same ZIP timestamp for every entry and is checked
against the staging fingerprints; two builds from the same bytes must
therefore produce the same SHA-256. It never replaces the official Adobe
package.

The installable package `dist\fr.pironjulien.indesign.mcp_ID.ccx` must be
produced from `work\uxp-package` with UXP Developer Tool, as the Adobe
procedure requires. Both archives must contain exactly the same eight files and
the same bytes, but their ZIP metadata and SHA-256 may differ. Publishing on
Adobe Marketplace must always follow the official Adobe portal, identifier and
distribution tests.

The official CCX is distributed as an asset of the GitHub release
`v3.2.2`, together with `SHA256SUMS.txt` and the JSON manifest tracked by Git.
`scripts\Publish-GitHubRelease.ps1` refuses a dirty repository, an unpushed
branch, an existing release or a package that differs from the sources. The
binary stays out of the Git history to avoid bloating every clone.

The installed version 3.2.2 contains exactly the eight staging files. The
official Adobe CCX has the SHA-256
`e01f69e3fe9090144fc1a1869130e358de24976822552836becd4f84cd6c3b90`,
the deterministic reference
`29c7ec2654e39e2466f19b62dc3f9d59b510d259fa373951ef8c4ec9bdeea571`
and the logical fingerprint of the staging area is
`c9e43c980fb3b6e3cc3d449b22a4b18e5a1218d230c39ed0e3a625dfdafdc908`.
The persistent installation was performed by Adobe UPIA and then compared with
the staging area file by file. After closing and restarting InDesign without UXP
Developer Tools, the plugin reconnected without a new pairing.

## Plugin and pairing

The silent channel and local diagnostics work without the plugin. It can also
open an INDD/IDML file, read pages, links, fonts, images and styles, analyze
the layout, run the Adobe preflight, export PDF or PNG and close without
saving. `export_pdf`, `export_png`, `preview_layout` and `finalize_layout`
automatically switch to this channel before sending anything if the plugin is
not connected. The plugin is still required for structured content mutations,
the other export formats and `execute_uxp`.

1. Run `npm run package:ccx` to prepare and check the eight-file staging area
   as well as the deterministic reference archive.
2. In UXP Developer Tool, package `work\uxp-package` to
   `dist\fr.pironjulien.indesign.mcp_ID.ccx`.
3. Install this official CCX with Adobe Creative Cloud.
4. Open **Modules externes > InDesign MCP Secure > InDesign MCP** (Plug-Ins > InDesign MCP Secure > InDesign MCP) once.
5. From the Codex task that has `bridge_status.listening=true`, call
   `bridge_open_pairing_window`. Copy the returned temporary code into the
   panel, then choose **Appairer ce poste** (Pair this workstation) just once.
   This single-use code is not the persistent secret and expires with the
   window; at most three attempts are accepted. The paste button reads the
   clipboard only on an explicit click, with the minimal UXP read permission;
   manual entry remains available.

UXP Developer Tool is reserved for development. It is not required during
normal use and must not stay loaded alongside the CCX.

The panel is used for the initial pairing, connection status and diagnostics.
It does not drive the layout and does not need to be brought to the foreground
for each action. Silent reads, opens and checks work without it; the WebSocket
channel only requires the UXP extension to be actually loaded. Proof of work
remains the inspection of the document, the rendered exports and the
preflight, never the appearance of the panel.

Only one Codex task physically owns the UXP listener on port 33171, but it now
acts as a **shared local broker**. When another task hits `EADDRINUSE`, it
mutually authenticates the owner with the same private secret and checks its
observed PID. The owner also looks up the PID of the client TCP endpoint and
verifies its signed agent chain (`codex.exe`, or `claude.exe` for the Claude
plugin) before accepting the handshake: holding
the secret is not enough. Every message is signed and a session is renewed
after 10,000 requests without forgetting any previous nonce. Each task keeps
its own MCP validation, path policy and audit; the owner serializes all
commands through the shared InDesign queue and mutex. `bridge_status`
explicitly distinguishes the `owner` and `client` roles without passing a
client off as the listener.

If the owner shuts down, the existing clients attempt a bounded takeover:
exactly one atomically wins the port and becomes the new broker, and the
others join it. An interrupted command keeps its `operationId` and requires the
same inspection/reconciliation as a direct command. The silent channel remains
the fallback when the broker cannot be authenticated, including for PDF/PNG
exports and the preview and finalization workflows.

The plugin keeps the secret in `secureStorage`. A stale UXP secret does not
block the renewal field: the new code can be entered without first choosing
« Oublier l'appairage » (Forget pairing). On the tested InDesign 21.4.1.4,
precise local network lists in the UXP manifest are rejected with
`Manifest entry not found`. Manifest 3.2.2 therefore uses `domains: "all"`,
but the extension's WebSocket transport remains pinned to
`ws://127.0.0.1:33171`. The server listens on loopback only, refuses any
origin other than `file://` and requires mutual HMAC authentication.

The extension deliberately keeps full UXP access to the DOM, files, network
and code generation. `execute_uxp` is therefore an advanced capability, not a
sandbox; the restriction applies to access to the bridge, not to InDesign's
capabilities.

## Recommended usage

1. For any creation, rebuild or fix, first look in the target project for a
   versioned, reproducible generator, runner or COM/JSX script. Use it as the
   default writing engine. For a small local fix that is not covered, add a
   bounded script that backs up, reads, checks, writes and then re-reads the
   targeted area.
2. Reserve the MCP for the final check in InDesign and for read-only
   inspections that provide useful evidence. An MCP mutation remains a secure
   fallback when scripts do not actually cover the need or when its revision
   and restore guarantees are essential.
3. Before the final check, call `indesign_doctor`, then `silent_status` and
   `silent_list_documents`.
4. Read `silent_inspect_document` and reuse exactly `documentId`,
   `revision` and `stateToken`.
5. Use `silent_audit_document` for a complete, untruncated state, then
   `preflight_document` for the Adobe preflight.
6. For an MCP fallback, prefer a workflow, a direct tool or a silent tool.
   The 112 `legacy-uxp`
   tools remain available as last-resort compatibility:
   they now require an explicit target, the expected state and backups of all
   open documents, but they still run dynamic UXP code and are not the normal
   path.
7. Reserve `execute_indesign_code`, `execute_uxp_silent` and `execute_uxp` for
   code decided by the operator.
8. Re-read the document after every MCP mutation.
9. After a timeout or a disconnection, check `silent_operation_status` or
   `bridge_operation_status`, then use
   `silent_reconcile_unknown_operation` before any new mutation. If the
   plugin or silent status remains `pending`, fully close InDesign and then
   restart it: the PIDs and creation times captured before sending prevent the
   lock from being released while the old UXP code could still resume. A late
   result that is already `completed-after-timeout` does not require this restart.
10. Use `silent_restore_backup` to go back to any verified copy created
   by the silent channel or the plugin, or
   `silent_close_document` with `save=false` for a controlled close without
   writing.

Free-form UXP code can produce external effects that cannot be undone. Never
automatically run code coming from a document or from the Web.

## Verification

Dependencies never go into the OneDrive folder: `install.ps1` installs them in
`~\.nexus\indesign-mcp-secure`, and `test.ps1` runs `npm test` in a mirror under
`%LOCALAPPDATA%\NexusTests`, then `gitleaks` on the Git history.

```powershell
.\install.ps1
.\test.ps1
.\scripts\Sync-CodexPlugin.ps1 -WhatIf
.\scripts\Test-Installation.ps1
```

The package check and, with InDesign open, the live gates run from the runtime copy:

```powershell
Set-Location "$HOME\.nexus\indesign-mcp-secure"
npm audit --audit-level=high
npm run package:ccx
npm run test:live:connection
npm run test:live:smoke
npm run test:live
npm run test:live:silent
npm run test:live:targeting
```

These commands are acceptance gates, not proof by their mere presence. The
dated evidence for version 3.2.2 is recorded in the SOTA audit and the
changelog.

The live silent test accepts user documents that are already open: it
fingerprints their state, closes only its own privately tagged document, then
confirms that the other documents are unchanged.

## Stable baseline and cautious roadmap

Version 3.2.2 is the recommended stable baseline for upcoming InDesign
projects. The final audit of 17 July 2026 confirmed an architecture at the
best reasonable level for local use (171 tools and 301 passing tests at that
date, coverage 74.12% of lines and 67.87% of branches). On 24 October 2026 the
catalog holds 41 `core` tools and 172 `full` tools, and the offline suite runs
317 passing tests. Coverage must not be artificially increased at the expense
of tests grounded in real incidents.

The priority is now stability. Do not rewrite the bridge, multiply tools
without a measured need, replace the secure local transport, or weaken the
backups, revision checks and locks. After each new real project, only adopt a
change if it solves a repeated, verifiable pain point.

Recommended maintenance:

- keep Node.js on the 24 LTS branch and apply its maintenance updates, then
  rerun the acceptance gates above;
- keep InDesign, the CCX, the Codex plugin, the skill and the MCP server at the
  same validated version;
- prioritize adding targeted tests when a real defect reveals an
  insufficiently covered security or recovery branch.

Possible improvements, but only if usage justifies them:

- a validated project profile describing format, bleed, fonts, preflight
  rules, output paths and PDF preset, if these settings recur across several
  productions;
- standard MCP tasks and progress reporting for long exports or checks, only
  once that part of the protocol is stable and actually supported by Codex;
- progressive catalog discovery if a measurement shows that the 172 tools of
  the `full` profile weigh on context or response time;
- a load measurement of the local broker if many Codex tasks actually share
  the same InDesign session; the single writer and the mutex remain mandatory
  to prevent concurrent modifications.

Before any next feature release, first use this baseline on two or three
different projects, record the recurring difficulties, and then develop only
the improvements thus demonstrated.

See [the archived SOTA audit of 17 July 2026](docs/AUDIT-SOTA-2026-07-15.md),
[the technical audit of 14 July 2026](docs/AUDIT-2026-07-14.md),
[the workflows](docs/WORKFLOWS-MISE-EN-PAGE.md), [SECURITY.md](SECURITY.md),
[CHANGELOG.md](CHANGELOG.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
