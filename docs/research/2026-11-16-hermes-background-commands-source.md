# Hermes background commands, from its source

November 16, 2026, issue #2637. Read from the `hermes-agent` 0.19.0 wheel on PyPI, unpacked and not installed; Hermes was not run. Nothing here was seen live.

## How a background command starts

- `terminal(background=true)` goes to `tools/process_registry.py`, `spawn_local`. Both of its paths run the command as `[user_shell, "-lic", f"set +m; {command}"]`: the PTY path (`ptyprocess` or `winpty`) and the pipe fallback (`subprocess.Popen(..., start_new_session=True)`).
- No other spawn in the package uses that form; the only other mention of it is a comment in `tools/environments/local.py`.
- The process is a child of the Hermes process. `start_new_session=True` gives it a session of its own, but its parent stays Hermes until Hermes exits.
- Its environment comes from `_sanitize_subprocess_env`, which calls `_inject_session_context_env`. That adds every bound `HERMES_SESSION_*` variable.
- The ACP adapter binds `set_session_vars(session_key=session_id)` for each prompt (`acp_adapter/server.py`), so the command carries `HERMES_SESSION_KEY` set to the thread's ACP session.

- MCP servers are children too, but `tools/mcp_tool.py` builds their environment with `_build_safe_env`, which keeps only safe variables, so they carry no `HERMES_SESSION_*`.
- A foreground command (`LocalEnvironment`) is its own `Popen` for that command, which ends with it. Hermes keeps no long-lived shell child.

## How it ends

- `notify_on_complete` puts the completion on `process_registry.completion_queue`.
- In this wheel, only `cli.py` and `tui_gateway/server.py` drain that queue. `acp_adapter/` has no drain, no list and no session update for it, so over ACP nothing says the command ended.
- The process ends when the command does. With `start_new_session`, it can outlive the Hermes process, after which it is no longer Hermes's child.

## Not covered

- `delegate_task(background=true)` runs its child agent on a thread inside the Hermes process (`tools/async_delegation.py`). It has no process of its own to find.
- Hermes on Windows was not read past `_find_shell` and `winpty`: whether the shell there takes `-lic` the same way is unchecked.
