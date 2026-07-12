# Herdr workflow workspace launch plan

## Goal

When `/task` or `/fix` creates a workflow workspace from inside a Herdr-managed pane, open a new Herdr workspace rooted at the new task/fix directory and start `pi` there. Herdr detection must take precedence over tmux and Ghostty because Herdr panes may inherit both terminal environments.

## Current behavior

- `detectTaskWorkspaceLaunchMode()` in `index.ts` returns `tmux`, `ghostty`, or `manual`.
- `selectAndStartTask()` creates the `jj` workspace and `.tasks/workflow.json`, then:
  - opens a tmux window when `TMUX` is set;
  - otherwise opens a Ghostty tab when `GHOSTTY_RESOURCES_DIR` is set;
  - otherwise prints `cd <workspace> && pi`.
- A Herdr pane sets `HERDR_ENV=1` but can also inherit `GHOSTTY_RESOURCES_DIR`, causing the workflow to open outside Herdr in a regular Ghostty tab.

## Herdr launch mechanism

Use the Herdr CLI wrappers against the current Herdr session:

1. Create and focus a Herdr workspace:

   ```sh
   herdr workspace create --cwd <workspace-path> --label <slug> --focus
   ```

2. Parse the JSON response for:

   - `result.workspace.workspace_id`
   - `result.root_pane.pane_id`

3. Start Pi in the root pane:

   ```sh
   herdr pane run <root-pane-id> pi
   ```

`herdr agent start` is not the preferred mechanism. It is useful for adding an agent to an existing workspace, tab, or split, but does not directly create a clean standalone workspace with Pi replacing its root shell. Creating a workspace and running `pi` in its root pane matches the desired layout.

## Implementation steps

### 1. Extend launch-mode detection

Update the launch-mode type to include `herdr`:

```ts
"herdr" | "tmux" | "ghostty" | "manual"
```

Change detection order to:

1. `HERDR_ENV === "1"` → `herdr`
2. `TMUX` → `tmux`
3. `GHOSTTY_RESOURCES_DIR` → `ghostty`
4. otherwise → `manual`

Herdr should take precedence over tmux as well as Ghostty: if `HERDR_ENV=1`, the workflow should remain managed by Herdr regardless of inherited inner-terminal variables.

### 2. Add a Herdr response parser

Add a small pure helper that parses `herdr workspace create` stdout and returns both IDs:

```ts
type HerdrWorkspaceLaunchTarget = {
    workspaceId: string;
    rootPaneId: string;
};
```

The parser should:

- catch invalid JSON;
- require non-empty `result.workspace.workspace_id`;
- require non-empty `result.root_pane.pane_id`;
- return a descriptive error rather than throwing into the command handler.

Keeping parsing separate makes the external command boundary easy to test.

### 3. Add the Herdr launch branch

In `selectAndStartTask()`, before the tmux and Ghostty branches:

1. Run:

   ```ts
   pi.exec("herdr", [
       "workspace", "create",
       "--cwd", wsPath,
       "--label", slug,
       "--focus",
   ])
   ```

2. If creation succeeds, parse its stdout.
3. Run:

   ```ts
   pi.exec("herdr", ["pane", "run", rootPaneId, "pi"])
   ```

4. On success, notify `Opened Herdr workspace: <slug>` and return.

Use `pi`, matching the tmux and manual launch paths and the requested behavior.

### 4. Handle failures without opening Ghostty

If Herdr was detected, a Herdr launch failure must not fall through to Ghostty. Ghostty variables are commonly inherited by Herdr, so falling through would reproduce the original bug.

Failure behavior:

- If `herdr workspace create` fails:
  - show a warning containing stderr/stdout;
  - continue to the final manual `cd <workspace> && pi` notification.
- If the response is malformed:
  - show a warning describing the missing/invalid response data;
  - continue to the manual notification.
- If workspace creation succeeds but `pane run` fails:
  - best-effort close the newly created Herdr workspace with `herdr workspace close <workspace-id>`;
  - include any cleanup failure in the warning or emit a second warning;
  - continue to the manual notification.

Do not remove the `jj` workspace or workflow file on launch failure; creation succeeded and the user can start Pi manually.

### 5. Add tests

Extend `test/index.launch.test.ts`.

Launch-mode tests:

- `HERDR_ENV=1` returns `herdr`.
- Herdr takes precedence over Ghostty.
- Herdr takes precedence over tmux.
- tmux still takes precedence over Ghostty when Herdr is absent.
- Ghostty and manual fallback behavior remains unchanged.
- Values other than the exact string `"1"` do not count as Herdr.

Parser tests:

- extracts workspace and root-pane IDs from a valid response;
- rejects invalid JSON;
- rejects a missing workspace ID;
- rejects a missing root-pane ID;
- rejects empty IDs.

If launch orchestration is extracted into a helper with injected command execution, also cover:

- successful create followed by `pane run`;
- create failure;
- start failure followed by workspace cleanup;
- cleanup failure does not hide the original start failure;
- no Ghostty command is attempted after a Herdr failure.

### 6. Update documentation

Update the workspace-launch description in `AGENTS.md`, which currently only mentions tmux. Describe the launch order as Herdr, tmux, Ghostty, then manual instructions.

## Verification

Run:

```sh
npm test
npm run typecheck
```

Manual verification from inside Herdr:

1. Confirm the current pane has `HERDR_ENV=1` and inherited Ghostty variables.
2. Start a new `/task` or `/fix` from the main repository workspace.
3. Confirm a new Herdr workspace is created with the selected slug as its label.
4. Confirm its root pane cwd is the new `~/.workspaces/<task-id>/<repo>` path.
5. Confirm `pi` starts in that pane and Herdr detects it as a Pi agent.
6. Confirm no separate Ghostty tab or tmux window is opened.
7. Confirm `/task` or `/fix` in the new Pi session binds the initially unbound workflow leaf and proceeds normally.

Regression verification outside Herdr:

- tmux still opens a new tmux window and starts Pi;
- Ghostty still opens a new tab;
- unsupported terminals still receive the manual `cd ... && pi` instruction.
