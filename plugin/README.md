# Nexus InDesign UXP Extension

InDesign UXP extension 3.2.2. It replaces the old unauthenticated `execute` channel with a signed protocol and a single execution queue.

## Compatibility and permissions

- InDesign 19.0 minimum, UXP manifest v5.
- The paste button reads the clipboard only on click, with the minimal
  `clipboard: "read"` permission; manual entry remains available.
- The plugin is a client of the fixed local WebSocket server: `ws://127.0.0.1:33171`.
- The bridge only accepts the `file://` origin actually sent by InDesign UXP;
  browser origins and connections without an origin are refused before the
  authentication challenge.
- On the tested InDesign 21.4.1.4, precise local WebSocket manifest entries
  are rejected with `Manifest entry not found`. The manifest therefore uses
  the UXP fallback `domains: "all"`, while the extension's transport
  stays pinned to
  `ws://127.0.0.1:33171` and the server refuses any remote address. It
  keeps full file system access and
  code generation so that `execute_uxp` keeps the requested UXP capabilities.
- No `launchProcess`, webview or IPC right is declared.
- Nonces use only `window.crypto.getRandomValues`, an API guaranteed
  by UXP. Since `SubtleCrypto` is not guaranteed, HMAC-SHA256 falls back without
  degradation to `vendor/js-sha256.js` 0.11.1 (MIT), fully local and
  covered by the RFC 4231 vectors.
- InDesign saving and the Undo step cannot undo the external effects of UXP code: network requests, writes outside the document or calls to a third-party service.

`domains: "all"` is a host permission, not a listening address. It
can also be used by the free-form code explicitly allowed through
`execute_uxp`, which deliberately remains a full capability and not a
sandbox.

## Pairing and authentication

Pairing requires proof that genuinely comes from outside the WebSocket:
`bridge_open_pairing_window` generates a random 64-bit code on the server side,
Codex shows it to the person, who then types it into the panel. The
bridge keeps only its salted hash and compares it in constant time. The
window is bounded to 30–300 seconds, the code is single-use and at most
three attempts are accepted.

1. Codex to person: temporary code `XXXX-XXXX-XXXX-XXXX`, never the persistent secret.
2. Plugin to bridge: `pair_request` with `pluginId`, `version`, `pairingNonce` and the entered code.
3. Bridge to plugin: `pair_secret` only after validation, with the same `pairingNonce` and a secret of at least 43 characters.
4. The secret is stored through `require('uxp').storage.secureStorage`.
5. On each connection, the bridge sends `auth_challenge`.
6. The plugin adds its own random nonce and returns `auth_proof`.
7. The plugin only accepts commands after verifying the mutual proof `auth_ok`.

The plaintext code is neither kept in the bridge state nor written to the audit log.
An old secret present in `secureStorage` does not prevent renewal:
the entered code takes priority over the stale authentication attempt.

Exact HMAC-SHA256 strings:

```text
plugin:<bridgeNonce>:<pluginNonce>:<pluginId>:<version>
bridge:<bridgeNonce>:<pluginNonce>:<pluginId>:<version>
```

Each command contains a new nonce and a hexadecimal HMAC-SHA256 proof. The signed string is:

```text
command:<bridgeNonce>:<pluginNonce>:<canonical JSON>
```

The canonical JSON contains, with sorted keys: `id`, `command`, `documentId`, `expectedRevision`, `nonce`, `args`. Nonces already seen are refused.

## Commands

The 36 structured commands:

```text
ping
list_documents
get_document_info
create_document
open_document
save_document
save_as
close_document
restore_safety_backup
list_pages
add_pages
get_page_content_summary
list_page_items
get_links
get_fonts
get_overset_text
get_images
analyze_layout
create_layer
create_color_swatch
create_paragraph_style
create_character_style
create_object_style
create_text_frame
edit_text_frame
create_rectangle
place_file
set_page_item_bounds
delete_page_item
create_master_spread
apply_master_spread
preflight_document
export_pdf
export_idml
export_png
package_document
```

Two technical commands, used by the server for backups and the
full capability, are added:

```text
create_safety_backup
execute_uxp
```

## Revision and backup

- Structured modifications require `documentId` and `expectedRevision`.
  The server also requires the `stateToken` silently re-read just before the
  command and checks the state again after it runs.
- Existing outputs are refused by default by the server; an
  `overwrite=true` request first creates a safety copy of the target.
- `export_png` accepts either `pageId` with `filePath`, or `folderPath` with an
  optional `pageRange`; these two forms cannot be mixed.
- The revision is stored in the InDesign label `fr.pironjulien.indesign.mcp.revision`.
- A successful modification increments this label.
- `execute_uxp` increments revisions after success as well as after an error, because an exception can occur after a partial modification.
- `create_safety_backup` requires an absolute directory passed by the core and uses `Document.saveACopy` with a random 144-bit identifier.
- After the plugin creates it, the server computes the SHA-256 hash and writes
  a persistent private provenance record. The copy thus remains verifiable and
  restorable through the silent channel after a restart.
- A backup authorizing an operation must be less than five minutes old, match the document, its revision and the reason, and can only be used once. Structured commands also check the exact name of the authorized command.
- Restoring closes the current version without saving it and opens the safety copy. It never automatically overwrites the original file.
- Every command that actually modifies content consumes a
  fresh backup tied to the document, its revision, the reason and the exact
  command name. Exports and packaging are also exclusive and backed up.

## Full UXP execution

`execute_uxp` accepts the `document` and `application` scopes. It requires a fresh backup of every document that may be touched. The code is compiled with `new Function`, then the asynchronous UXP function is awaited directly so its result and proof are kept after each `await`. InDesign 2026 does not reliably return the Promise of an asynchronous function passed to `app.doScript`; safety therefore relies on mandatory backups of all open documents, revisions, state tokens and verification of the targeted document.

The code, its arguments, paths and contents are never written to the plugin console. Logs only contain the event name, the command and a stable error code.

Before sending a command, the bridge records the InDesign PIDs and their
creation times in its private log. After a timeout or a disconnection, an
operation still `pending` can only be reconciled after InDesign has been fully
closed and actually restarted; merely waiting for stability could not
prevent asynchronous UXP code from resuming. If a late response has already
marked the operation `completed-after-timeout`, that proof of completion avoids the
restart while keeping the inspection mandatory.

## Known limitations

- The extension must be loaded by InDesign. Depending on the version and installation mode, the first load may only happen when the panel is first opened.
- The registry authorizing fresh backups lives in memory: restarting
  the plugin requires a new backup before `execute_uxp`. Files
  already created and their private provenance do persist, however, and remain
  restorable through the silent channel.
- Available DOM APIs, presets and profile names depend on the InDesign version and language.
- An Undo transaction and an INDD copy protect the document, not the external network effects or files produced by free-form code.
- The `document` scope is a backup policy, not a DOM sandbox: signed UXP code deliberately has access to the `app` object. Use the `application` scope if the code may touch several open documents.

Technical limits:

- pairing window: 30 to 300 seconds, 64-bit code, three attempts; nonce anti-replay window: 15 minutes;
- WebSocket message: 4 MiB; queue: 100 commands, processed strictly one at a time;
- `execute_uxp` code: 2,000,000 characters; JSON structure: depth 12, 10,000 nodes;
- authorization backup: 5 minutes and single use; restore: 30 minutes;
- serialized result: depth 8, 5,000 items per array, 500 keys per object and 200,000 characters per string.
