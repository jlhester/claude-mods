# claude-mods

Mods for [Claude Code](https://code.claude.com): plugins that change its interface.

## command-log

A pane beside the chat that shows the Bash commands Claude runs and what they print.

- Each command is shown in full, every line of it, with long lines wrapped to the pane.
- Background commands stream live: their output is followed as it is written, and the entry is marked when the command completes, fails or is killed.
- Foreground commands show their output when they finish.
- Several running commands show side by side. By default a finished command stays until the next one starts; turn on **Keep history** to keep the last 30.

Status marks: `…` running, `⟳` running in the background, `✓` done, `✗` failed, `■` stopped.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install command-log --marketplace jlhester/claude-mods
```

Answer `y` to add the marketplace, then choose a scope (user is first). From a shell:

```
claude plugin install command-log --marketplace jlhester/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jlhester/claude-mods`, then Add plugin.

### Use

- The pane opens by itself the first time Claude runs a Bash command. `/logpane close` closes it, and it stays closed until `/logpane` opens it again. `/logpane clear` empties it.
- The pane sits on the right in fullscreen mode (`/tui fullscreen`) in a terminal at least 110 columns wide; otherwise it sits above the prompt.
- **Keep history** (off by default): `/logpane history` turns it on or off, and `/logpane history on` or `off` sets it. It is also a row in `/config`.

### Limits

- Foreground output appears when the command ends, not while it runs: Claude Code hands a mod a foreground command's output only once it finishes.
- Live following uses `tail`, so it needs a Unix-like system (Linux, macOS, WSL).
- Panes from mods may not draw in the VS Code extension yet.

## License

MIT; see [LICENSE](LICENSE).
