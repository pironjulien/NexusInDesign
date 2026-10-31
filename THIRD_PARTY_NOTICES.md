# Third-party components

## Adobe InDesign UXP documentation

- Project: <https://github.com/AdobeDocs/uxp-indesign>
- Publisher: Adobe
- Pinned revision: `ba9d36134a4c2ee72dc03e16bbac3144e1263327`
- License: Apache-2.0 (`native/reference/LICENSE.AdobeDocs.txt`)
- Embedded file: `native/reference/indesign-dom-paths.xml`
- SHA-256: `c1b0d48666943c69847556a26e52b13f3d2a43b7b0efa410802e2c71c0a32331`

The official sitemap is kept unchanged and only serves `search_official_dom` as a local, read-only index of Adobe's
published DOM documentation. No user document and no network request are involved.

## JsonSchema.Net

- Project: <https://github.com/json-everything/json-everything>
- License: MIT
- Use: checks the tools' arguments against their JSON Schema 2020-12 contracts (NuGet package, compiled into the engine).

## System.Drawing.Common

- Project: <https://github.com/dotnet/winforms>
- Publisher: Microsoft (.NET Foundation)
- License: MIT
- Use: downscales the verified preview PNGs into the capped JPEG thumbnails returned with `run_layout_script` and
  `preview_layout` (NuGet package, Windows GDI+, compiled into the engine).
