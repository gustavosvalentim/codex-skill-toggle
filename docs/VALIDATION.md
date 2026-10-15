# Validation — 2026-10-14

## Runtime policy behavior

Executable: the runtime bundled with the desktop app, `codex-cli 0.160.1`.

Four fresh read-only sessions used a temporary Git project containing one fixture skill. Each case wrote a unique checksum into its skill body. The prompt did not contain the checksum. The following results passed:

| Case | Setting | Invocation | Result |
| --- | --- | --- | --- |
| Automatic enabled | true | No skill mention | Returned that case's checksum |
| Automatic disabled | false | No skill mention | UNKNOWN |
| Explicit while disabled | false | `$skill-toggle-policy-probe` | Returned that case's checksum |
| Automatic restored | true | No skill mention | Returned that case's checksum |

See `policy-validation.json` for the report. This is a behavioral check on this runtime, not a proof that the model can never discover a skill by searching arbitrary files. An earlier trial was discarded because its reports were stored in the fixture and a later case read a previous answer. The corrected runner isolates reports and randomizes every case's checksum.

These tests establish fresh-session behavior. They do not establish the minimum live refresh action for an existing desktop chat or erase instructions already loaded into a conversation.

## Desktop manager

The actual embedded manager opened in Codex mode and listed 19 existing skills with current policy states. System skill switches were disabled. A temporary twentieth fixture was discovered and filtered through search.

Its switch was clicked off in the embedded UI. The server reported a verified disk save, and direct inspection showed `allow_implicit_invocation: false`, with the original YAML comment and display name preserved. The switch was clicked on again and the file read back as true. The disposable fixture was removed afterward.

No existing user skill policy was changed during validation. The MCP server was restarted before testing the new list and write tools.

## Automated checks

`npm run check` and ten `npm test` cases pass:

- Real STDIO server metadata, UI resource and input validation.
- SDK app bridge forwarding to the real local process.
- Missing policy creation and restoration.
- YAML preservation, permissions, and stale-write rejection.
- Invalid mappings, duplicate YAML keys and policy aliases.
- Duplicate skill names, root escapes and bundled skills.
- Symlinked files and directories.
- Repository-bounded project discovery, disabled skill state and unavailable projects.

## Remaining limits

- Live refresh of existing desktop chats is unverified.
- Public directory publication is not performed. Installation uses the local plugin marketplace.
- Discovery covers configured local roots, not a complete host plugin inventory.
- Enablement display reads supported path-based config entries, not all live host policies.
- Atomic replacement does not eliminate races with independent external editors.


## Plugin packaging

The portable package contains root plugin and MCP manifests, a dependency-bundled server, its embedded UI, dependency license notices, and an explicit-only launcher skill. The official skill validator passes.

A clean-copy test runs the server outside the source tree without node_modules and retrieves the embedded resource through MCP. Ten automated tests pass.

Codex installed and enabled `codex-skill-toggle@skill-toggle-local`. App-server skill discovery reports `codex-skill-toggle:skill-toggle` with that owning plugin ID. After removing the old standalone MCP registration, app-server MCP discovery reports `codex-skill-toggle` owned by the plugin, no tool-discovery error, and all four manager tools.

The local marketplace ZIP includes its own catalog and relative plugin paths. The separate plugin-only ZIP has the portable plugin at its root. Installed code is loaded from the plugin cache rather than the source directory.

## Direct launch — version 0.2.1

The installed plugin now advertises both global (sidebar app) and thread (conversation panel) entry points. Codex app-server discovery confirms the plugin-owned launch tool has both entries and no discovery error. These host entry points invoke the local app directly without a model turn; the conversational skill remains optional and does use a turn. All ten tests and skill validation pass.

Native sidebar placement has not been visually verified because automation cannot operate the Codex shell. Refreshing the desktop plugin inventory may be required after upgrading to expose the new global entry.

## Launcher removal — version 0.2.2

Removed the bundled launcher skill from source and both distributable archives. Installed version 0.2.2. Fresh app-server `skills/list` with forced reload returns no Skill Toggle launcher. MCP discovery still reports the plugin-owned server without an error, with both global and thread launch entries. TypeScript checks and all ten automated tests pass, including archive checks for launcher absence. Existing user skill policies were not changed. Native sidebar placement remains visually unverified.

## Project context — version 0.3.0

Twelve protocol/persistence tests pass. New cases use an isolated fake app-server to verify two independent chat projects, internal/ephemeral/missing/projectless fallbacks, personal-only selection, explicit override, folder validation, persisted folder registration, global defaults after restart, and project-policy writes. The real bundled runtime was separately verified to attach threadId metadata and return a saved chat's cwd through metadata-only thread/read. The completed server also passed a combined real-runtime check: host-style threadId request metadata resolved a real saved chat through the bundled app-server and selected that chat's directory. Native conversation-menu launch has not yet been validated end to end.

A temporary browser harness rendered the production panel and forwarded its bridge calls to the real STDIO server. Adding a disposable project displayed its path and project-labeled skill; switching that fixture off and back on succeeded. Existing user skill policies were not changed.

## Cross-process project refresh — version 0.3.2

Fixed project lists that remained frozen after the server started. Listing now reloads saved project registrations; adding a folder first merges the latest saved list. A regression test starts two servers before either folder is registered, verifies Refresh exposes another server's registration, and verifies subsequent additions preserve both folders. All thirteen tests pass. Selecting a project in an empty new-chat view is not equivalent to having a saved chat ID; explicit folder selection is supported in that view.
