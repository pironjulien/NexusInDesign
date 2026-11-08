# Development instructions

- Target Adobe InDesign 2024 to 2026 and .NET 10. The engine drives InDesign only through COM (`DoScript`, UXP under
  `NEVER_INTERACT`): no Node.js, no Adobe UXP plugin, no network listener.
- Structured, validated tools come first; `run_layout_script` (backup, script, preview in one pass) is the normal way to
  write; `execute_uxp_silent` stays for advanced needs. Free code is not a sandbox: it keeps the full rights of Adobe
  scripts.
- Every mutation: explicit reason, expected revision and `stateToken`, backups of every open document, durable lease and
  the shared mutex `Local\NexusInDesignAutomation`. An unknown outcome is never presented as a success.
- Backups, audit and runtime stay in `%USERPROFILE%\.nexus\nexus-indesign\private` (refused under OneDrive), private DACL,
  never in Git. Logs hold no document text, full path or secret.
- The server starts only under an allowed agent process chain (Claude Code, Codex): name, folder and signature checked.
  Tests inject their own parent verifier; there is no bypass switch.
- The engine and its launcher are Native AOT: AI sessions keep their MCP server running for hours while updates
  replace it, and a single-file .NET exe loads code from its own file later on (`UpdateWhileRunningTests`). No
  reflection: COM through `InDesign/Dispatch.cs` (generated `IDispatch`), JSON through `JsonContext`, P/Invoke through
  `LibraryImport` with blittable structures. A `JsonArray.Add` or collection expression of a `JsonObject` must be cast
  to `JsonNode` (the generic overload is not AOT-safe); the AOT publish fails on any such warning. Publishing needs the
  C++ linker, found through `vswhere`: `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer` on `PATH`
  (tools/package.ps1 and the tests add it).
- The `nexus-indesign` skill (`plugin/skills`) serves Codex and Claude Code: no instruction specific to one agent.
- After a significant change: update `CHANGELOG.md` (English, Keep a Changelog), run `test.ps1`, check the diff and
  the absence of secrets, then commit precise files with an English message.
