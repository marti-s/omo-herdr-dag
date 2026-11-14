# OmO Herdr DAG

**Live OmO workflow DAGs in a Herdr side pane.**

English | [한국어](README_KO.md) | [简体中文](README_ZH.md)

`omo-herdr-dag` is an [OmO](https://github.com/code-yeongyu/oh-my-openagent) extension that opens a dedicated TUI in [Herdr](https://herdr.dev/) when a workflow DAG appears. Follow dependencies and node states beside your conversation, with focus kept in the original pane.

This fork supports the newer `herdr-core` (`hc`) and `herdr-app` terminal layout as well as the legacy `herdr pane` interface. Install it from [marti-s/omo-herdr-dag](https://github.com/marti-s/omo-herdr-dag); the upstream npm package does not include this fork's `herdr-app` attachment changes.

![OmO running an integration review on the left, with navigation, gate-wiring, and test-coverage running and verify-evidence pending in the Herdr DAG pane on the right.](https://raw.githubusercontent.com/jc01rho/omo-herdr-dag/main/docs/screenshots/workflow-in-progress-en.png)

*An integration review in progress: `navigation`, `gate-wiring`, and `test-coverage` run in parallel; `verify-evidence` depends on all three. The right pane shows node states, dependencies, and task details beside the conversation.*

https://github.com/user-attachments/assets/cd918f5f-3b89-43c8-9d75-34fddadb2760

The screenshots show the **English** interface, which is the default for new installations; select Korean with `--lang ko` or Simplified Chinese with `--lang zh-cn`. Node labels come from your workflow and are displayed unchanged. The viewer also shows an explicit close hint after disconnection.

## Features

- Attaches the viewer to its owning session's tab in `herdr-app`; legacy Herdr opens a right-hand pane using about 35% of the original pane's width.
- Updates node states and dependencies from OmO workflow snapshots.
- Reuses a healthy viewer across updates and recovers a lost viewer process in an existing terminal without trusting terminal existence alone.
- Keeps completed and failed runs in the saved session snapshot.
- Supports scrolling and switching between runs.
- Automatically expands running task details and folds other states unless you saved a different choice.
- Displays ordinary subtasks from the current session even when no workflow DAG exists.
- Remembers each node's expanded or collapsed state across updates and viewer restarts.
- Respects manual closure: use `/dag-pane` to reopen the viewer.
- Uses Node built-ins, with no npm dependencies or changes to the OmO package.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 24 or later. Tested with 24.14.0 and 26.7.0. |
| OmO | A version exposing the `omo.dag.updated` event. Verified with `5.0.0-0.beta.42` and Senpi `2026.9.4-3`. |
| Herdr | New interface: `herdr-core`/`hc` and `herdr-app`, with OmO running in its own managed terminal. Legacy interface: `herdr` on `PATH` with the pane commands described below. |
| Terminal | Run OmO inside a Herdr-managed terminal or legacy pane, with a UTF-8 terminal and font that supports box-drawing characters. |

**Custom OmO agent registration in Herdr is not required by this extension.** Run `omo` in a managed terminal. With the new interface, the extension uses `hc` terminal labels and `herdr-app` window placement to attach beside the owning session, retaining its lane name and returning focus to the agent. The legacy interface uses `herdr pane` commands.

See [verification and compatibility](VERIFICATION.md) for the historical live checks and exact version combinations. Those checks do not establish live compatibility of this fork's new `herdr-app` recovery changes; the current changes have local automated coverage. Legacy Windows panes are expected to use PowerShell, not cmd.exe or Git Bash.

## Install

Install OmO and Herdr separately first. Use this fork's source installer for `herdr-app` support and the recovery fixes below.

### From this fork

```bash
git clone https://github.com/marti-s/omo-herdr-dag.git
cd omo-herdr-dag
npm ci --ignore-scripts
npm test
node scripts/install.mjs --dry-run
node scripts/install.mjs
```

The first installation defaults to English. To choose Korean or Simplified Chinese:

```bash
node scripts/install.mjs --lang ko
node scripts/install.mjs --lang zh-cn
```

Use `node scripts/install.mjs --lang en` to select English. Updates keep the saved language unless you select another one. The explicit installer copies the extension into OmO's agent directory; updating a checkout alone does not replace the installed copy.

### Upstream npm package

The [upstream npm package](https://www.npmjs.com/package/omo-herdr-dag) is distributed separately. Running `npx omo-herdr-dag@latest install` installs that upstream version and can replace this fork's installed integration. Use the source installer above to retain this fork's behavior.

There are no runtime npm dependencies. Windows tests use the development-only `node-pty` ConPTY bridge; POSIX tests use Python 3 and a Unix PTY. `--dry-run` prints the destinations without changing files. The source installer also accepts `--lang en`, `--lang ko`, or `--lang zh-cn`.

The installer uses `--agent-dir`, then `OMO_CODING_AGENT_DIR`, then `SENPI_CODING_AGENT_DIR`, falling back to `~/.omo/agent`. For example, with `OMO_CODING_AGENT_DIR=~/.omo`, the entry is `~/.omo/extensions/omo-herdr-dag.js`, not `~/.omo/agent/extensions/omo-herdr-dag.js`. The default fallback layout is:

```text
~/.omo/agent/
├── extensions/omo-herdr-dag.js      # Extension entry point
└── herdr-dag/integration/
    ├── current.json                # Active installation generation
    └── generation-000001/           # Extension, src/, locale.json, LICENSE
```

Start a new OmO session inside Herdr, or run `/reload` in an existing session. The first workflow DAG snapshot opens the viewer automatically. You can also run `/dag-pane` in OmO to open an empty viewer while waiting for a DAG.

### Custom agent directory

If your OmO installation loads extensions from a different agent directory:

```bash
node scripts/install.mjs --agent-dir /path/to/your/agent-directory
```

This changes the installation destination. It does not configure OmO's extension discovery or change the default runtime state directory.
The npm CLI accepts the same `--agent-dir` option.

## Controls

Type `/dag-pane` in OmO to open the viewer before a workflow starts, or to reopen a pane you closed. It waits for a workflow snapshot, then displays the graph as updates arrive.

On startup, the extension also restores the current session's saved DAG checkpoints from `<task state directory>/dag/runs/` and joins their task details. If the viewer cache is empty, `/dag-pane` attempts the same recovery without rerunning any tasks. Checkpoints from other sessions are not displayed. Installing new files does not replace code already loaded by a running OmO session: reload the extension before using the recovery.

Events and file watches provide immediate updates. A two-second recovery pass also rereads task records, DAG checkpoints, and the viewer snapshot, so a missed notification does not leave the display frozen. Newer recorded timestamps take precedence over older replayed state. Recovery rereads reported state; it does not rerun tasks or infer that a workflow node finished because its worker finished.

![OmO command completion listing dag-pane with an English description for opening or reopening the current session's DAG pane.](https://raw.githubusercontent.com/jc01rho/omo-herdr-dag/main/docs/screenshots/dag-pane-command-en.png)

| Where | Command or key | Action |
| --- | --- | --- |
| OmO | `/dag-pane` | Open or reopen the current session's viewer. |
| OmO | `/reload` | Load or reload the extension. |
| DAG pane | `↑` / `↓`, `k` / `j` | Scroll. |
| DAG pane | `Page Up` / `Page Down` | Scroll by a page. |
| DAG pane | `←` / `→` | Switch between runs. |
| DAG pane | `t` | Switch between DAG and ordinary Tasks. Without a DAG, Tasks is the default view. |
| DAG pane | `f` | Toggle automatic follow. Re-enable it to reveal the current running work immediately. |
| DAG pane | `Tab` / `n`, `Shift+Tab` / `p` | Select the next or previous node and bring its details into view. |
| DAG pane | `Space` / `Enter` | Collapse or expand the selected node's details, including its child tasks. |
| DAG pane | `d` | Toggle full details for the selected task or node without changing its saved collapse preference. |
| DAG pane | `q`, `Ctrl+C`, `Ctrl+D` | Close the viewer and its generated pane. |

`>` marks the selected node, `[-]` means expanded, and `[+]` means collapsed. The graph and dependency list remain above the detail panels. Preferences live in `<snapshot path>.view.json`; this viewer-owned file is not overwritten by workflow updates.

Borders, titles, and status marks use execution state, not selection: running is cyan, completed green, failed/error red, and paused/blocked yellow. Automatic follow defaults to ON and keeps the same running target until it finishes, then follows the next running node or ordinary task. It reveals DAG boxes in the graph rather than jumping to their detail cards, and switches views or runs when needed. Parallel arrivals and streamed text do not cycle between targets.

Only `f` toggles automatic Follow. Scrolling, selection, run/view switches, folding, and full-detail inspection provide a temporary view; the next redraw follows active work again while Follow is ON. Press `f` first to keep inspecting older work. The footer shows localized Follow ON/OFF; disconnected snapshots show OFF and do not display live model activity. Follow is temporary viewer state and does not alter saved fold preferences.

DAG detail cards show the graph's node label in their top border, even when folded, without adding a row. Long labels are clipped to the pane width; `d` shows the full label and node ID.

The same selection and collapse keys work in Tasks. Running tasks appear first, and ordinary task preferences are stored by task ID separately from DAG node preferences. The task count remains visible from the DAG view.

Expanded task cards default to four compact lines: status and task description, agent and short model name, one line of progress, and elapsed time with turn/tool counts. Long progress is clipped in this view. Press `d` for the task ID, exact timestamps, full model name and the supplied progress text; press it again to return to the compact card. Full-detail viewing is temporary and does not replace the saved expand/collapse setting.

While a running in-process task is calling its model, the progress line shows whether that call is alive: `✎ now · …newest text` (response), `💭` (thinking), `⚙ write now · …` (tool arguments being generated), `⏳ waiting for model 12s` (request sent, no token yet), `▶ bash running 1m 5s` (tool running, model idle) and `↻ retry 2/3 · 4s` (provider retry). Token phases show the time since the last token; when no token arrives for 30 seconds, or no first token for 90 seconds, the line starts with `⚠ possibly stalled` and the running DAG node turns yellow. Long tools are never flagged. The running DAG node box shows the same summary after its state, and `d` adds a Model activity line. OmO only publishes the latest assistant line after each message ends, so the pane reads these events from the Senpi `AgentSession` shared through OmO's in-process barrel. Tasks run in a separate process, or an OmO build that no longer exposes that barrel, fall back to the normal progress line. If OmO has loaded that barrel but it no longer exposes `AgentSession._emit`, the session shows a single warning.

The `herdr-core` viewer closes when its owning OmO session ends. Legacy Herdr retains the last graph with a disconnected indicator and an explicit close hint:

```text
○ Disconnected · snapshot saved
You can close this pane with q.
```

You may keep the snapshot open for reference or press `q` to close the viewer and its generated pane. Closing the viewer does not cancel workflow tasks or delete the saved snapshot. Expired snapshots are pruned from the state directory when the extension starts; see `OMO_HERDR_DAG_RETENTION_DAYS` under Configuration. The close hint appears only while disconnected; it does not mean every workflow task completed successfully.

If the snapshot's owner is gone, stale-state cleanup marks the snapshot disconnected and clears live model activity. It preserves the last reported task and workflow statuses: loss of the display connection is not evidence that the work was cancelled or completed.

## Configuration and local data

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMO_HERDR_DAG_STATE_DIR` | `~/.omo/agent/herdr-dag/` | Directory for snapshots and pane records. Set before starting OmO. |
| `OMO_HERDR_DAG_TASK_STATE_DIR` | `<project>/.omo/senpi-task/` | OmO task store root, containing `tasks/`. Set this to the same directory when using a custom OmO `task.state_dir`. |
| `OMO_HERDR_DAG_LANG` | Saved installation language, initially `en` | Override the interface language with `en`, `ko`, or `zh-cn`. Set before starting OmO or reloading the extension. |
| `OMO_HERDR_DAG_NODE` | Validated host Node, otherwise `node` on `PATH` | Node.js 24+ executable for the viewer. Set before starting OmO; paths containing spaces are supported. |
| `OMO_HERDR_DAG_RETENTION_DAYS` | `14` | Days before startup prunes expired snapshots and pane records from the state directory. The current session's files are always kept; `0` or an invalid value disables pruning. Set before starting OmO or reloading the extension. |

`install --lang ko` saves the selection in the active generation's `locale.json`. The installer prints that directory as `integration`; `integration/current.json` identifies the current generation. Updates retain the language unless you pass another `--lang` value. Use `install --lang en` to switch back to English. The environment override takes precedence; unsupported override values fall back to English.

Herdr supplies `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` to its panes. The extension also requires that socket path to exist and a real `herdr` executable (`HERDR_BIN_PATH` when it is an existing file, otherwise `herdr` on `PATH`). Leftover environment from a previous Herdr session, including a `HERDR_BIN_PATH` that ends with ` (deleted)`, does not activate the viewer. Do not set those variables manually to target another pane.

The new `herdr-core` path uses `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` supplied by the managed terminal. It resolves `herdr-core`/`hc` and `herdr-app` from `PATH` or `~/.local/bin`; `HC_BIN_PATH` and `HC_APP_BIN_PATH` can specify the executables explicitly. If the app window does not show the owning session yet, attachment backs off instead of placing the viewer in another tab.

Standalone builds such as `omob` still need a separate Node.js 24+ installation for the viewer. The extension checks the runtime before opening a pane and resolves the actual Node executable, including when `node` is a version-manager shim. It does not launch the viewer through the compiled OmO binary. To select Node explicitly, start OmO with `OMO_HERDR_DAG_NODE=/absolute/path/to/node omob`. An invalid explicit path produces a warning instead of falling back to another runtime.

Snapshots are local JSON files. They contain session and run IDs, names, node labels, states, task IDs, dependency edges, and error messages. Workflow prompts are omitted, but labels and errors may still contain project information. Keep runtime files out of public issue reports and source control. The extension adds no external network service or telemetry.

Viewer startup and reuse are checked through a local loopback endpoint and a receipt bound to a unique launch token, session, state file, and pane/terminal ID. An existing terminal or live PID alone is insufficient. The controller waits for the viewer's readiness acknowledgment and, after a bounded health check, replaces an existing terminal whose viewer is gone or has the wrong identity. A missing terminal stays closed for the current run: app closure and removal after a crash cannot be distinguished, so use `/dag-pane` or start a new run to reopen it. Pressing `q` records an intentional close for that launch. These checks stay on the local machine and send no workflow content over the network.

Task details are linked to workflow nodes by their task IDs. Available task descriptions, agent/model information, progress, timestamps, and counters appear alongside explicitly linked child tasks. Missing details are not estimated. A child-task relationship is separate from a workflow dependency; the viewer does not turn dependency edges into parent/child links.

Workflow nodes keep the state reported by OmO's DAG, while linked task details keep the worker's task status. These sources can disagree temporarily; neither is silently overwritten to match the other. Use `d` to compare the same task ID and its reported state. The agent's TODO checklist is separate and is not an input to this extension.

Progress is a selected latest assistant excerpt with the current tool when supplied by OmO, not a transcript. Stored progress is limited to 512 characters and descriptions to 2,000; the detail panels wrap the supplied text. Full task prompts, output, and final responses are not copied into these snapshots.

Without a saved choice, running tasks expand automatically and every other state stays folded. Automatically expanded tasks fold when they finish. Your explicit expanded/collapsed choices always take priority: a running task you fold stays folded across updates, and a task you expand stays open after completion. Choices are saved separately from workflow snapshots, keyed by run ID and node ID within the session, and survive retries, run switches and viewer restarts. Automatic state changes are not saved. Space/Enter changes your saved choice; `d` temporarily reveals full details and then returns to the current effective fold state without changing that choice. Task descriptions and progress text may also contain project information, so keep these local records private.

## Update and uninstall

To update this fork, obtain the new source from `marti-s/omo-herdr-dag` on the branch you use, then rerun `node scripts/install.mjs`. Do not use the upstream npm `@latest` installer to update this fork. Each installation creates a fresh generation directory, so `/reload` loads new transitive modules rather than cached code. Previous generations remain as backups; legacy flat installations are moved to a backup directory. Reinstalling also deletes `extensions/herdr-dag.js` when this installer created it. Senpi treats a loaded `herdr-*.js` file as a user Herdr reporter and then skips its built-in agent presence, so the entry point is `extensions/omo-herdr-dag.js`. Runtime records and language are preserved. The installed copy is independent of the source checkout or npm cache. Run `/reload` in existing OmO sessions afterward. Close any viewer still running old code with `q`, then use `/dag-pane` to reopen it.

To uninstall, remove `~/.omo/agent/extensions/omo-herdr-dag.js`. Also remove `extensions/herdr-dag.js` if an older install left it there, then reload or restart OmO. Close any existing DAG panes yourself. You may keep `~/.omo/agent/herdr-dag/` as a record, or remove it separately. For a custom installation, remove the entry point from that agent directory instead.

## FAQ

### Is this an OmO plugin or a Herdr plugin?

It is an **OmO extension**. The installer places it in OmO's agent directory, where it listens for workflow updates. It uses `hc`/`herdr-app` or legacy `herdr pane` commands to manage the viewer; no plugin is installed into Herdr itself.

### What happens if Herdr is missing or I start OmO outside Herdr?

| Environment | Behavior |
| --- | --- |
| Herdr is not installed | You can install the extension, but it stays inactive in an ordinary terminal. |
| Herdr is installed, but OmO runs in an ordinary terminal | The extension stays inactive and does not register `/dag-pane`. Having the Herdr application open is not enough. |
| OmO runs inside a Herdr pane | The extension activates, registers `/dag-pane`, and opens the viewer when a workflow DAG arrives. |
| OmO runs in a managed `herdr-core` terminal | The extension activates through the `HC_TERMINAL_*` environment and attaches the viewer to the session's tab when `herdr-app` shows it. |
| Legacy Herdr environment variables are present, but the socket or `herdr` executable is missing | The extension stays inactive and does not register `/dag-pane` or attempt pane commands. |

Activation uses either the legacy `HERDR_*` pane environment with `herdr`, or `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` with `herdr-core`/`hc`. The corresponding socket must exist. Inactive sessions do not subscribe to DAG updates or open viewer panes. Start OmO in the managed terminal rather than setting another terminal's identifiers manually.

### Must I register OmO as a custom agent in Herdr?

No. Run `omo` or `omob` directly in a managed Herdr terminal. The extension uses terminal/pane IDs and CLI commands rather than agent registration or sidebar recognition. See [VERIFICATION.md](VERIFICATION.md) for the tested version combinations; the new `herdr-app` recovery changes have not yet been exercised in a live app session.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/dag-pane` is unavailable | Reload OmO, confirm the extension was installed in its active agent directory, and confirm OmO is running inside Herdr. |
| No pane opens automatically | The extension opens for workflow DAGs or current-session OmO tasks. Generic `parallel()` calls without OmO task records are not tasks. Check the OmO version and custom task-store path; manually closed panes require `/dag-pane`. |
| A pane was closed and stays closed | This is intentional for the current run. Run `/dag-pane` to reopen it; a new run can also open a viewer. |
| `omob` reports `Unknown options: --state, --close-pane` | Update this extension, close the failed DAG pane, run `/reload` in OmO, then `/dag-pane`. The old launcher mistook the compiled OmO binary for Node. |
| A `DAG pane:` warning appears | Check the executable and socket for your interface: `herdr-core`/`hc` plus `herdr-app`, or legacy `herdr pane`. Startup must receive a matching viewer acknowledgment. Inspect any incomplete viewer before retrying with `/dag-pane`. |
| A restored terminal is only a shell | The controller checks viewer identity and can replace a lost viewer. Use `/dag-pane` for an explicit retry; a terminal's existence does not prove the viewer is ready. |
| A status appears stale | Allow the two-second recovery pass, then compare the graph and task status with `d`. Check the configured task store and any read/watch diagnostics. Refreshing cannot correct an upstream record that is itself stale. |
| An edge is hard to follow | Inspect the incoming IDs inside each node and the complete edge list below the graph. Scroll if necessary. |

## How it works

```text
OmO workflow snapshot: omo.dag.updated
OmO task progress: omo.task.updated + local task records
Startup recovery: current-session DAG checkpoints
    → Senpi shared event bus: senpi:extension-rpc-event
    → Filter by the current parent session ID
    → Write a normalized local snapshot
    → Open/reuse a Herdr pane; its TUI watches the snapshot file
```

Ordinary subtasks appear in a separate task list rather than as fabricated dependency nodes. Tasks already linked to any displayed DAG are excluded from that list; their children remain under the owning task. Only current-session tasks and their explicitly linked descendants are collected.

The bridge listens to the installed Senpi event bus and periodically rereads current-session task records and checkpoints. The `herdr-core` adapter launches a labelled viewer terminal and uses `herdr-app` to attach it to the owning session's tab, preserving lane placement and focus. The legacy adapter uses `herdr pane split --ratio 0.65 --no-focus`, `rename`, and `run`, leaving approximately 35% for the new pane.

This integration depends on OmO/Senpi internal event contracts, which may change between versions. It reads explicit workflow edges; it does not infer dependencies between unrelated tasks. Wide frontiers wrap, and dependencies that skip a frontier are represented by incoming IDs and the edge list. Long labels and errors are clipped to the terminal width.

## Development

```bash
npm test
npm run build
npm run test:package
```

The tests run without OmO or Herdr and use temporary local files and mocked pane commands. `build` assembles the dependency-free JavaScript distribution in `dist/` and checks its syntax. `test:package` packs it, installs the tarball offline in a temporary project, and verifies the CLI, installation, updates, and language selection. `npm run check` runs all three steps.

GitHub Actions runs these checks on Node 24 and 26 on Linux, then uploads an npm `.tgz` artifact. Installed-runtime and manual live-pane checks are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Distribution

This fork's source and CI artifacts are hosted on [marti-s/omo-herdr-dag](https://github.com/marti-s/omo-herdr-dag). The npm package is the separate upstream distribution; publication of this fork is not implied by its package version. The installer copies runtime files into your OmO agent directory, where they run locally. A tarball built from this fork can be installed with `npm install -g ./omo-herdr-dag-1.7.0.tgz`, followed by `omo-herdr-dag install`.

The inherited **Release to GitHub and npm** workflow is separate from source installation. Publishing requires the appropriate repository and npm configuration; this change does not publish a release. Ordinary branch pushes run CI; manually running the publish workflow performs a dry run. See [RELEASING.md](RELEASING.md) before publishing from a fork.

Contributions, compatibility reports, and improvements to terminal rendering are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## License

[MIT](LICENSE). This is an independent community extension, not an official OmO or Herdr component.
