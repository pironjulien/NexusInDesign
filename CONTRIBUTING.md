# Contributing

## Environment

- Windows 10 or 11, .NET SDK 10 (`global.json`);
- Node.js on the PATH for the tests only (syntax check of the generated UXP scripts);
- Adobe InDesign 2024 to 2026 for real checks (never needed by the tests).

## Rules

1. Never commit a business document, a secret, a token or an INDD backup.
2. Keep the safeguards: path policy, revision and `stateToken` checks, backups before any mutation, durable lease,
   audit without content.
3. A new InDesign capability is a UXP template in `native/uxp/` plus its tool contract in `native/tool-contracts.json`;
   its emulation in `tests/FakeInDesign.cs` and a test go with it.
4. A protocol fix starts with a test that really fails.

## Checks

```powershell
.\test.ps1
git diff --check
```

`test.ps1` runs the xUnit suite (`dotnet test`): the engine against an emulated InDesign, the COM host's mutex, the
syntax of every generated script and `get.ps1` on a local package. Build and test outputs go to
`~\.nexus\build\nexusindesign`. A change to a UXP template must also be tried in a real InDesign test document: the
emulation does not prove DOM compatibility.

## Version

One version everywhere: `native/Program.cs`, `native/NexusInDesign.csproj`, both plugin manifests, `server.json` and the
top section of `CHANGELOG.md` (Keep a Changelog). The `Release` workflow checks them, builds, attests and promotes.
