# Codex Skill Toggle

<img src="plugin/assets/icon.svg" width="64" height="64" alt="Skill Toggle icon">

Manage automatic skill invocation from an embedded panel inside Codex. The TypeScript app runs through a local STDIO MCP server; it does not require a separate website or hosted service.

## Use it

For routine use, open **Skill Toggle** from the desktop sidebar's app picker. Version 0.2.5 advertises a global sidebar entry as well as a conversation-panel entry. These entries open the UI directly through MCP, without sending a prompt or invoking a model. Once open, search, refresh, and toggle actions also call the local server directly.

Refresh the app/plugin inventory after upgrading if the sidebar entry has not appeared. Exact placement depends on the desktop host. Native sidebar placement has not been checked through UI automation; the installed server's global entry metadata is verified.

The plugin does not bundle a launcher skill. You can still ask Codex to call `open_skill_toggle`, but that conversational route consumes a model turn.

Search for a skill and change its “Allow automatic invocation” switch:

- On: Codex may choose it automatically.
- Off: it remains available through explicit invocation, such as `$skill-name`.

Changes are verified on disk before the panel reports success. Use a fresh Codex chat after changing a policy. Live refresh of an already-running desktop chat is not verified, and already-loaded instructions can remain in its context.

The setting does not enable a skill disabled in Codex configuration. Bundled/system skills, unsafe symlink targets, and invalid policy files are read-only. The panel lists configured local folders rather than every plugin installed in the host.

## Build and test

Requires Node.js 22 or newer, plus `zip` and `unzip` on your PATH for packaging and package tests.

```sh
npm ci
npm run check
npm test
```

The ten automated tests cover the actual STDIO server and SDK bridge, missing policies, restoration, YAML comments and fields, file permissions, conflicts, duplicate names, symlink boundaries, project discovery and disabled-skill state.

To run the separate model-behavior validation using an existing Codex sign-in:

```sh
npm run validate:policy
```

By default it uses the Codex runtime bundled with the macOS desktop app. Set `SKILL_TOGGLE_CODEX_BIN` to use another executable. This validation invokes the model four times with a temporary project and unique checksums. Reports live outside the fixture project to prevent one case from reading another case's answer. It does not modify existing skills or install a fixture globally.

See [validation results](docs/VALIDATION.md).

## Install the plugin

Requires Node.js 22 or newer available as `node`. The release contains the server and all JavaScript dependencies; an installed plugin does not need `npm install`.

Clone and build the repository:

```sh
git clone git@github.com:gustavosvalentim/codex-skill-toggle.git
cd codex-skill-toggle
npm ci
npm run package:plugin
codex plugin marketplace add "$PWD"
codex plugin add codex-skill-toggle@skill-toggle-local
```

Refresh or restart the desktop app if its plugin picker has not updated. This plugin does not install a launcher skill. If you previously registered the development MCP server, remove that registration to avoid duplicate servers.

To install from a locally built archive, extract `release/codex-skill-toggle-marketplace-0.2.5.zip` into a folder, then run:

```sh
codex plugin marketplace add /absolute/path/to/extracted-folder
codex plugin add codex-skill-toggle@skill-toggle-local
```

The marketplace archive includes `.agents/plugins/marketplace.json` and a self-contained plugin directory. `release/codex-skill-toggle-0.2.5.zip` is the portable plugin-only archive; it does not include a marketplace catalog.

Use one source for `skill-toggle-local` at a time. To move an existing local marketplace, remove its registration before adding the new location.

Rebuild with `npm run package:plugin` after source changes, update the installed plugin through Codex, and reopen its panel. Local plugins load from the cache, not directly from the repository. Increment the plugin version for releases.

This repository distributes a local plugin; it is not listed in the public plugin directory.

## Configure projects and roots

Without configuration, discovery uses `~/.agents/skills` and `~/.codex/skills`. Symlinked roots are supported. Identical resolved skill paths are deduplicated, while skills sharing a name remain distinct.

For project discovery in a standalone development server, create a local JSON config based on `config.example.json`, replacing the example path. Register with:

```sh
codex mcp add codex-skill-toggle -- /absolute/path/to/node /absolute/path/to/codex-skill-toggle/dist/server.js --config /absolute/path/to/config.json
```

A project's `.agents/skills` directories are scanned from its configured working directory up to the nearest repository root. If no repository exists, only the configured working directory is scanned. The manager does not scan all of `~/repos`.

An optional `roots` array replaces the default personal roots:

```json
{
  "roots": [{ "path": "/absolute/path/to/skills", "writable": true }],
  "projects": []
}
```

Only configured project IDs are accepted from the UI. Changes to this configuration require an MCP server restart. The plugin defaults to personal roots. Project configuration for the packaged plugin is not exposed in a settings UI yet; use a standalone development registration if you need the explicit `--config` argument, and disable the plugin to avoid duplicate servers.

## Tools

- `open_skill_toggle`: list skills and present the embedded manager.
- `list_skills`: rediscover configured roots, optionally filtered by project ID.
- `set_implicit_invocation`: save a boolean policy using a skill ID and expected revision.
- `check_connection`: UI-only diagnostic used by the bridge test.

Skill IDs derive from canonical paths. Writes reject stale revisions, preserve unrelated YAML fields and comments, and replace files atomically. Writes in one server are serialized per skill. There remains a narrow race with unrelated external editors between the final revision check and rename; this is not filesystem-wide compare-and-swap.

Enablement badges read path-based entries from the user and selected project Codex config. They are not a complete introspection of every host profile, administrator policy, or live runtime override.

## Remove

```sh
codex plugin remove codex-skill-toggle@skill-toggle-local
codex plugin marketplace remove skill-toggle-local
```

Removing the plugin does not undo policy changes previously saved to your skills.

## Layout

- `src/server/skills.ts`: discovery, config parsing and policy writes.
- `src/server/index.ts`: MCP tools and resource registration.
- `src/ui/`: embedded list, filters and controls.
- `src/shared.ts`: shared schemas and tool contracts.
- `scripts/`: bundling and isolated policy validation.
- `tests/`: fixture-based protocol and persistence tests.
- `SPEC.md`: specification and delivery status.

The MCP Apps SDK is pinned to 1.7.5 for compatibility with MCP SDK 1.x. Upgrade them together across major versions. The plugin and local marketplace packaging are implemented. Public directory publication is separate.
