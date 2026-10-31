# Security

## Reporting a vulnerability

Report any vulnerability privately through
[GitHub private vulnerability reporting](https://github.com/pironjulien/NexusInDesign/security/advisories/new), never in
a public issue. First answer within 3 days; a confirmed vulnerability is fixed in a new version, then published in a
GitHub security advisory. Only the latest version is supported.

## Trust boundary

- Claude Code or Codex starts `NexusInDesign.exe --mcp` and talks to it over stdio. The engine opens **no network
  listener** and exposes no HTTP API.
- Start-up is refused unless an ancestor of the process (up to 20 levels, PID reuse rejected by start times) is an
  allowed agent: `claude.exe` signed by Anthropic or `codex.exe` signed by OpenAI by default, with a valid Authenticode
  signature (WinVerifyTrust), in an allowed folder (`INDESIGN_MCP_ALLOWED_PARENT_NAMES`, `_SIGNERS`, `_PATHS`).
- InDesign is driven only through its COM automation server, in-process: `DoScript` runs UXP scripts written to a
  private runtime folder, under `NEVER_INTERACT`. No panel, no Adobe UXP plugin, no clicks.

## Paths

Every path a structured tool reads or writes is resolved through junctions and symbolic links, then must stay inside
the allowed roots (default: the user profile; `INDESIGN_MCP_READ_ROOTS` / `_WRITE_ROOTS` or `settings.json`), outside
the denied roots (private storage, `~\.nexus`, `.ssh`, `.gnupg`, AppData, plus `INDESIGN_MCP_DENIED_ROOTS`), with the
extension the tool expects. An existing target is replaced only with `overwrite=true`, after a private copy.

Free code (`run_layout_script`, `execute_uxp_silent`) runs with the full rights of Adobe scripts, including files and
network: it is not a sandbox, and agents are told to run only code decided for the task.

## Private storage

Backups, the audit journal and the runtime live in `%USERPROFILE%\.nexus\nexus-indesign\private` (refused under
OneDrive), with a protected DACL granting the current user and SYSTEM only; junctions inside are refused. The audit
journal records tool, document, revision, outcome, error code, backup identifiers and a SHA-256 of the reason, never a
document text, a path, code or a secret.

## State, backups and recovery

- Every mutation checks the document's revision and `stateToken` (a 64-bit fingerprint of content and structure)
  before it runs and again after; any difference refuses or flags the outcome.
- Every open document is backed up (`saveACopy`, INDD signature and SHA-256 recorded in a provenance file) before any
  mutation; a restore checks that provenance and backs up the current state first.
- Every mutation holds a durable lease (`.mutation-lease.json`) and the Windows mutex `Local\NexusInDesignAutomation`,
  owned by the engine's COM thread for the whole operation and shared with every Nexus InDesign tool of the session.
  A mutex left abandoned refuses the next command once.
- An unknown outcome (timeout, crash) keeps the lease, the script and its result file: every InDesign command is then
  refused until `silent_reconcile_unknown_operation` proves the documents stable, backs them up and records a receipt.
  When the script may still run, it first requires a full restart of every InDesign process alive at dispatch.
- Produced files are verified structurally (PDF xref, PNG chunks and CRCs, IDML ZIP structure and designmap, INDD
  signature), never trusted from InDesign's report alone.

## Releases

Every release file is built by GitHub Actions and attested (Sigstore build provenance through NexusSystem's shared
workflows); `get.ps1` checks the SHA-256 of what it downloads against the release's `SHA256SUMS.txt` before extracting
anything. Check a file by hand with `gh attestation verify <file> --repo pironjulien/NexusInDesign`.
