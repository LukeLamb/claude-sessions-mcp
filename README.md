# Claude tmux Sessions

Lets [Claude Desktop](https://claude.ai/download) on Linux start, monitor, and control long-running jobs inside `tmux` sessions. Designed for ML training, data pipelines, and anything else you want to survive beyond a single conversation.

Claude can start a detached training run, check on it an hour later by capturing the last N lines of its pane, send keystrokes (including `Ctrl+C`), and kill the session when done. You can `tmux attach -t <name>` from any real terminal to watch the same session live — Claude and a human can observe simultaneously.

## Requirements

- **Linux** with `tmux` installed:
  ```bash
  sudo apt install tmux
  ```
- Works with the default per-user tmux server (no shared-server setup needed).

## Install (Claude Desktop)

1. Download the latest `Sessions.mcpb` from the [Releases](https://github.com/LukeLamb/claude-sessions-mcp/releases) page.
2. In Claude Desktop: **Settings → Extensions → Extension Developer → Install Extension** → pick the `.mcpb`.
3. Enable the extension.

## Tools

| Tool | Annotation | What it does |
|---|---|---|
| `list_sessions` | read-only | All tmux sessions with name, windows, created/activity timestamps, attached flag |
| `has_session` | read-only | Exact-match check for a session name |
| `list_windows` | read-only | Windows within a session (index, name, active, pane count) |
| `capture_pane` | read-only | Last N lines of the session's active pane (default 100, max 10000) |
| `new_session` | destructive | Start a detached session; optionally run an initial shell command |
| `send_keys` | destructive | Send key combos or text to the active pane (Enter appended by default) |
| `kill_session` | destructive | Terminate a session (sends SIGHUP to all processes inside) |

## Example workflows

**Start a training run:**
> _"Start training run `b8-c1`: activate my `rdna4-train` venv and run train.py."_
>
> `new_session name=b8-c1 command="source ~/.venvs/rdna4-train/bin/activate && python /media/luke/Storage\ Device\ 1/NeuroForge/train.py b8-c1"`

**Check on it later:**
> _"Is training `b8-c1` still going? Show me the last 50 lines."_
>
> `capture_pane name=b8-c1 lines=50`

**Interrupt a hung run:**
> _"The training is stuck — send Ctrl+C."_
>
> `send_keys name=b8-c1 keys="C-c" enter=false`

**Wrap up:**
> _"Kill the session."_
>
> `kill_session name=b8-c1`

## Key notation

`send_keys` accepts either literal text (sent as keystrokes) or tmux key names. Common ones:

| Keys | Effect |
|---|---|
| `C-c` | Ctrl+C (interrupt) |
| `C-d` | Ctrl+D (EOF / logout) |
| `Escape` | Escape key |
| `Up`, `Down`, `Left`, `Right` | Arrow keys |
| `Enter` | Enter (also appended automatically when `enter` is true) |
| `Space` | Space |

Pass `enter: false` when sending raw combos so you don't get an extra Enter after.

## Privacy policy

This extension runs entirely on your local machine and shells out only to the `tmux` binary. No data leaves your machine. No network I/O. No sockets. No files written outside of tmux's own per-user server socket (default `/tmp/tmux-$UID/default`).

The information visible to Claude includes session names, pane contents (the text you or your programs have printed), and session metadata (created/activity timestamps, window/pane counts). `send_keys` and `kill_session` can affect any process running inside a managed session, so treat it with the same trust level you'd give to a user typing into your terminal.

## Troubleshooting

**"tmux is not installed"** — run `sudo apt install tmux`.

**"can't find pane" errors** — generally means the named session was killed mid-operation. Call `has_session` first, or use `list_sessions` to see what's actually running.

**Session name restrictions** — names cannot contain `.`, `:`, `|`, or whitespace. The `.` and `:` are tmux target separators; `|` is this server's field delimiter; whitespace is rejected on principle.

**Session doesn't survive my initial command** — by design, `new_session` always starts a shell; the `command` argument is sent as keystrokes into that shell. That's what keeps the session alive after the command finishes. If you passed `command` directly to `tmux new-session` it would exit when the command did.

## Development

Single ~300-line Node.js script, zero npm dependencies. Rebuild the `.mcpb`:

```bash
cd bundle-source
zip -j ../Sessions.mcpb manifest.json package.json server.js README.md LICENSE icon.png glama.json
```

## License

MIT. See [LICENSE](LICENSE).

## Related

- [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) — shell, filesystem, and background jobs (for shorter-lived commands where tmux would be overkill).
- [claude-linux-mcp](https://github.com/LukeLamb/claude-linux-mcp) — X11 desktop control.
- [claude-rocm-mcp](https://github.com/LukeLamb/claude-rocm-mcp) — AMD GPU monitoring; use alongside this one to check GPU health during training.
