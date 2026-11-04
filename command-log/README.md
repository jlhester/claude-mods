# command-log

<img src=".claude-plugin/icon.png" alt="command-log icon" width="64" height="64">

A pane beside the chat that shows the Bash commands Claude runs and what they print.

- Each command and its output are shown in full, with long lines wrapped to the pane.
- Background commands stream live: their output is followed as it is written, and the entry is marked when the command completes, fails or is killed.
- Foreground commands show their output when they finish.
- Several running commands show side by side. By default a finished command stays until the next one starts; turn on **Keep history** to keep the last 30.

Status marks: `…` running, `⟳` running in the background, `✓` done, `✗` failed, `■` stopped.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install command-log --marketplace jlhester/claude-mods
```

Answer `y` to add the marketplace, then choose a scope (user is first). From a shell:

```
claude plugin install command-log --marketplace jlhester/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jlhester/claude-mods`, then Add plugin.

## Use

- The pane opens by itself the first time Claude runs a Bash command. `/logpane close` closes it, and it stays closed, in later sessions too, until `/logpane` opens it again. `/logpane clear` empties it.
- The pane scrolls: use the mouse wheel, or click it (or press `ctrl+x tab`) and use the arrow keys or Page Up/Down. It opens at the newest output and follows new lines while you are at the bottom.
- The pane sits on the right in fullscreen mode in a terminal at least 110 columns wide; otherwise it sits above the prompt. Outside fullscreen the pane asks once whether to switch. `/logpane fullscreen` switches at any time. It runs `/tui fullscreen`, which applies to all your sessions and restarts this one; `/tui default` switches back.
- Opening by itself takes a terminal 144 columns wide, or 110 once you have opened the pane with `/logpane`; below that, a message says so once. `/logpane` opens it at any width.
- **Keep history** (off by default): `/logpane history` turns it on or off, and `/logpane history on` or `off` sets it. It is also a row in `/config`.

## Examples

- Ask "Run the tests and fix any failures". Each test run and its output appear in the pane, so you can follow along without expanding anything in the chat.
- Ask "Start the dev server in the background, then check the home page loads". The server's output streams into the pane while Claude keeps working, and its entry is marked when it stops.
- Run `/logpane history on`, then ask "Find out why the build fails". The pane keeps the last 30 commands, so you can read back everything Claude tried.

## Limits

- Foreground output appears when the command ends, not while it runs: Claude Code hands a mod a foreground command's output only once it finishes.
- Live following uses `tail`, so it needs a Unix-like system (Linux, macOS, WSL).
- Panes from mods may not draw in the VS Code extension yet.

## What it runs, reads and changes

**What it sends:** nothing. The mod makes no network calls and sends nothing to any server. Commands and their output are shown only in the pane on your screen, and are held in memory for the session only.

**Programs it runs:** one, `tail -n +1 -F <file>`. When Claude runs a Bash command in the background, Claude Code writes the output to a file and the mod follows that file with `tail` to show the output live. It follows at most 5 files at a time, and each `tail` is stopped when its command ends or the session closes. The file path comes from the Bash tool's result and is passed as an argument, with no shell.

**Files it reads:** only those same output files, once more when a background command ends, so the pane shows the whole output. A file over 4 MiB is left out, and the pane keeps what `tail` read.

**Commands it runs:** one, `/tui fullscreen`, and only when you choose Switch in the pane or run `/logpane fullscreen`. It never runs this by itself.

**Configuration it changes:**

- `tui`: `/tui fullscreen` sets this Claude Code setting to `fullscreen`, for all your sessions, and restarts the current session. `/tui default` switches back.
- `keep_history`: this mod's own option, set by `/logpane history` or in `/config`, and saved under `pluginConfigs` in your Claude Code settings.
- The mod's own store, a JSON file under `~/.claude/plugins/store/`, remembers whether you answered the fullscreen question, whether you closed the pane, whether the narrow-terminal message was shown, and that a switch is under way. It holds no commands or output.

**Credentials:** the mod does not look for or read any credential. If a command prints a secret, that output shows in the pane, as it does in the conversation, and goes nowhere else.

**Hooks:**

- `tool.call` (Bash): records the command, its description and its output for the pane. It never changes, delays or blocks the command, or its result.
- `session.append`: looks in each new conversation message for the notice that a background command ended, and keeps nothing else from it.
- `command.run`: answers `/logpane`.
- `session.start`: registers `/logpane` and loads the mod's saved answers.
- `ui.close`: notes that you closed the pane.
- `ui.render`: draws the pane.

## License

MIT; see [LICENSE](../LICENSE).
