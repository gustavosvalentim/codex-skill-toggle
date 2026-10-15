# Codex Skill Toggle

Status: Local plugin packaged, installed, and validated
Date: 2026-10-05
Updated: 2026-10-14

## Goal

Give users an embedded desktop panel for switching local Codex skills between automatic invocation and explicit invocation only. Users should not need to edit YAML or open a separate website.

The experience is inspired by Pi's skill-toggle extension. It extends Codex through an MCP App rather than modifying Codex's existing Skills screen.

## User experience

The user opens Skill Toggle inside the desktop app. The panel lists skills, their descriptions, their scope, and their current invocation setting. Each editable skill has an “Allow automatic invocation” switch.

- On: Codex may select the skill when a prompt matches its description.
- Off: the skill is available through explicit invocation, such as `$skill-name`.
- Missing policy: display On, reflecting the documented default.
- Invalid or unreadable policy: display an error state and disable editing until resolved.

Switching a setting saves it immediately. Show success only after reading the file back and verifying the persisted value. A failed save leaves the displayed setting unchanged and shows a useful error.

Provide search, scope filters, and a manual refresh action. Identify skills by their path, not just their name: duplicate skill names can exist.

Distinguish automatic invocation from whether a skill is enabled at all. A skill disabled in Codex configuration must not be presented as active simply because automatic invocation is allowed.

## Scope

The first release supports user-authored personal and project skills on the local desktop host. The interface runs inside the desktop app; there is no separate browser UI or public server.

System skills, plugin cache skills, and skills outside approved writable roots are visible only if discovery provides them, and read-only initially. Editing installed plugin files is excluded because plugin updates can overwrite them. A persistent per-user override for plugin skills requires separate investigation.

Non-goals:

- Changing the native Codex Skills screen.
- Managing plugin installation, skill installation, or skill deletion.
- Disabling skills entirely through `skills/config/write`.
- Remote-host or cloud skill editing in the first release.
- Guaranteeing that an already-running chat forgets previously loaded skill instructions.

## Architecture

```text
Embedded MCP App panel
        │ tools/call through the host bridge
        ▼
Local MCP server (STDIO)
        │ constrained filesystem operations
        ▼
<skill directory>/agents/openai.yaml
```

Use TypeScript for the local Node.js MCP server and the embedded UI. Bundle the UI as a self-contained MCP App resource served by the local process. Use the official MCP and MCP Apps SDKs, and share tool input/output types between the server and UI. A standalone executable is not required for the initial validation spike.

The server provides its bundled UI as an MCP resource with MIME type `text/html;profile=mcp-app`. A read-only launch tool references the resource through `_meta.ui.resourceUri` and declares an `openai/ui` thread entry point. Add global or settings entry points only after validating their availability in the installed host.

The UI invokes backend tools through the MCP Apps bridge. It does not spawn processes, access arbitrary files, or send skill contents to a hosted service. The host launches the local server through its supported STDIO MCP configuration.

A locally configured MCP server is sufficient for the integration spike. Plugin packaging and distribution follow after the embedded workflow works.

## Backend contract

### `list_skills`

Input: optional configured project identifier. Do not accept an arbitrary filesystem path from the UI.

Output: a list of skills with stable IDs, names, descriptions, scope, display paths, policy state, editability, and any discovery errors. Include a revision token for each editable policy file.

A revision token represents the current file bytes, including a distinct state for an absent file. Do not use name alone as identity.

### `set_implicit_invocation`

Input: skill ID, desired boolean value, and expected revision token.

Resolve the ID through the server's discovery registry. Reject unknown IDs, non-editable skills, malformed policies, or changes made since the UI loaded the file.

Output: the verified persisted policy state, a new revision token, and refresh guidance. Setting a value that is already present is a successful no-op.

### `open_skill_toggle`

Read-only launch tool associated with the UI resource. Return initial list data or let the panel call `list_skills` after initialization.

## Discovery

Investigate using the host's skill discovery results where accessible. The app-server protocol exposes `skills/list`, but a local MCP subprocess is not automatically given an authenticated connection to the desktop app's running app-server. Do not assume such a connection exists or attach to undocumented sockets.

If host discovery is unavailable to the MCP process, use explicit configured roots and project registrations. Support the documented personal `.agents/skills` location and explicitly configured legacy `.codex/skills` locations. For projects, reproduce the documented scan from the selected working directory through the repository root. Do not recursively scan all of `~/repos`.

Support symlinked skill folders during discovery, but determine editability from the resolved target. Deduplicate identical resolved skill paths while preserving distinct skills with the same name.

Return partial results with per-root errors when one directory is inaccessible.

## Policy persistence

The setting is stored in `agents/openai.yaml`:

```yaml
policy:
  allow_implicit_invocation: false
```

The documented default is true. Preserve unrelated interface, dependency, and policy fields. Use a YAML parser that preserves comments and formatting where practical. Reject ambiguous or invalid documents rather than silently rewriting them.

Create `agents/` and `openai.yaml` when absent, only within an editable skill directory. Preserve existing file permissions. Commit changes through a temporary file in the same directory followed by an atomic rename, and verify the resulting value.

Validate real paths and symlink behavior before writing. Re-check the expected revision immediately before committing. Serialize writes within the service; document the remaining race with unrelated external editors rather than claiming atomic compare-and-swap across processes.

## Refresh semantics

The app-server protocol documents `skills/list` with `forceReload` and `skills/changed` notifications. Those mechanisms do not by themselves prove that the embedded MCP server can trigger a refresh in the running desktop host.

Validate whether changing `agents/openai.yaml` is watched by the desktop app and whether new turns or new chats observe the new invocation policy. Separate three states in implementation and messaging:

1. The setting was saved and verified on disk.
2. The host rediscovered the setting.
3. The invocation behavior changed for an applicable model turn.

Never show “active in this chat” based solely on a successful filesystem write. If needed, instruct the user to start a new chat or restart the app, based on observed behavior.

## Integration evidence and limits

Read-only inspection of the installed desktop bundle on 2026-10-05 found:

- A `McpAppThreadSidePanelTab` component.
- MCP tool metadata handling for global, thread, and settings entry points.
- `ui://` resource handling and the MCP App HTML MIME type.
- Embedded app routing to `mcpServer/resource/read` and `mcpServer/tool/call`.

Temporary fixture tests against the app's bundled Codex runtime, version 0.160.0, confirmed discovery of `agents/openai.yaml` UI metadata. The separately installed Homebrew CLI behaved differently, so tests must identify the executable used.

The initial bundle inspection was implementation evidence only. Subsequent desktop and isolated model tests are recorded below and in docs/VALIDATION.md.

## Implementation progress (2026-10-14)

Gate 1 is validated in the installed Codex desktop app. The local TypeScript STDIO server serves a self-contained MCP App panel. TypeScript checks, the real STDIO protocol test, and the App → AppBridge → STDIO integration test pass.

The initial tool launch rendered the app inline; a thread entry point alone did not expand it. The UI now checks the host's advertised display modes after connecting and requests `fullscreen`. In this desktop host, that exposes the expanded panel to the MCP Apps browser. If the host declines expansion, the inline UI remains usable.

Desktop validation opened the actual panel in the current Codex chat, found its enabled Check connection button, clicked it, and observed “Local connection verified” with a matching local server response. No additional model turn was needed for the click. No skill files were read or edited.

The UI resource reader loads the rebuilt HTML from disk, so this display-mode fix worked without terminating MCP processes or restarting Codex. The server has since been restarted with the manager tools. Tool response text is never treated as proof of rendering.

Gate 2 passed four isolated model cases on bundled Codex 0.160.1: automatic-on, automatic-off (UNKNOWN), explicit invocation while off, and automatic restoration. Each case used a fresh session and unique checksum; reports were kept outside the fixture project. Live refresh in an existing desktop chat remains unverified. The UI recommends a fresh chat and only claims persistence on disk.

Gate 3 is implemented: configured personal/project discovery, shared schemas, search and scope/project filters, read-only states, revision conflict detection, comment-preserving YAML writes, exact file permission preservation, and persisted-value verification. Eight automated tests pass. The desktop manager listed 19 existing skills; a temporary additional fixture was toggled off and back on through the actual embedded UI, verified on disk, and removed. Existing user skill policies were unchanged.

Configuration and contract details are in README.md and src/shared.ts. Gate 4 is implemented: portable plugin manifest, bundled STDIO server and UI, dependency notices, local marketplace catalog, plugin-only and marketplace ZIP archives, with direct global and conversation-panel launch entries. Version 0.2.2 removes the bundled launcher skill to favor direct UI access. Codex installed and enabled `codex-skill-toggle@skill-toggle-local`. The plugin-owned server starts and exposes all four tools. The standalone development registration was removed after validating the plugin replacement. Public directory publication is outside this local packaging work.

## Delivery gates

### 1. Embedded integration spike

Implement a minimal local MCP server with a UI resource and a read-only panel containing a button. Register it in the desktop app and verify:

- A thread entry point appears and opens the panel inside the app.
- The resource is rendered rather than shown as raw text.
- Clicking the button calls the local server and updates the panel without a model turn.
- The panel works in Codex mode, rather than only in ChatGPT mode.
- Any relevant account gates, approval requirements, or server restart requirements are recorded.

Do not proceed to a full skill manager if the installed host cannot expose this embedded experience.

### 2. Policy behavior spike

Use an isolated test skill. Confirm automatic invocation before the change, explicit-only behavior after the change, continued explicit invocation, and restoration to automatic behavior. Repeat prompts sufficiently to distinguish a probabilistic model choice from harness exclusion; inspect exposed skill context where available.

Determine the minimum reliable refresh action. Do not test by toggling the user's existing skills.

### 3. Functional implementation

Implement discovery, read-only states, YAML updates, conflict detection, and the embedded list with switches.

### 4. Packaging

Package the validated local server and UI for installation. Document supported desktop versions, startup configuration, uninstall steps, and update behavior. Avoid modifying app bundles or relying on private host APIs.

## Acceptance criteria

- The user operates the manager entirely inside the desktop app.
- An embedded click updates a fixture skill's policy through the local server.
- Explicit-only skills remain available for explicit invocation.
- Missing policy files can be created without damaging skill instructions.
- Existing YAML fields and comments survive an edit, within documented parser limitations.
- Duplicate names, malformed YAML, symlinks, read-only files, and concurrent edits are handled predictably.
- Failed writes never appear as successful toggles.
- The interface accurately distinguishes persisted state from host refresh state.
- No real user skill is changed by installation or smoke tests.

## References

- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Plugin UI extensions](https://developers.openai.com/plugins/build/extensions)
- [MCP App UI integration](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
