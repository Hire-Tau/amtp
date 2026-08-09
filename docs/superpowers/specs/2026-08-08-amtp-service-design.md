# `amtp service` — persistent daemon setup

**Date:** 2026-08-08
**Status:** Approved

## Goal

Let a user register `amtp serve` as an always-running service on their machine
with one command — like `pm2 startup`, but scoped to amtp. User-level services
only (no sudo): launchd LaunchAgents on macOS, systemd user units on Linux.

## Command surface

New commander group in `node/src/commands/service.ts`, registered from
`node/src/index.ts`:

```
amtp service install [--bin <path>]   # write unit, enable, start
amtp service uninstall                # stop, disable, remove unit
amtp service start
amtp service stop
amtp service restart
amtp service status                   # installed? running? pid, paths
amtp service logs [-f] [-n <lines>]
```

All verbs respect the global `--home <dir>` flag / `AMTP_HOME` env var and the
global `--json` flag (via the existing `setOutputOptions` / `outputError`
plumbing in `src/output.ts`).

## Naming: one service per home

The service identity derives deterministically from the resolved home:

- Default home (`~/.amtp`): name `amtp`.
- Any other home: `amtp-<basename>-<hash6>` where `<basename>` is the home
  directory's basename sanitized to `[a-z0-9-]` (lowercased, other runs of
  characters collapsed to `-`) and `<hash6>` is the first 6 hex chars of
  SHA-256 of the resolved absolute home path.

Platform mapping:

- **launchd:** label `com.amtp.<name>`, plist at
  `~/Library/LaunchAgents/com.amtp.<name>.plist`.
- **systemd:** unit `<name>.service` at
  `~/.config/systemd/user/<name>.service`.

Because every verb re-derives the same name from `--home`, services for
multiple homes coexist and are addressed only by `--home`.

## Install

1. **Precondition:** the home must be initialized — `config.json` must exist.
   Otherwise error: `Home <dir> is not initialized — run \`amtp init\` first.`
2. **Executable resolution:** the unit must point at an absolute command.
   - Compiled binary: `process.execPath` is the amtp binary itself →
     `ExecStart = <execPath> serve`.
   - npm/bun-shim case (basename of `process.execPath` is `bun`):
     `ExecStart = <execPath> <process.argv[1]> serve`.
   - `--bin <path>` overrides with `<path> serve` (resolved to absolute).
3. **Unit contents:** bake in `AMTP_HOME=<resolved home>` as environment. No
   host/port flags — `config.json` (`serve.host` / `serve.port`) is the single
   source of truth; config changes take effect on `amtp service restart`.
4. **Write + activate:**
   - launchd: write plist with `RunAtLoad=true`, `KeepAlive=true`,
     `StandardOutPath`/`StandardErrorPath` = `$AMTP_HOME/logs/serve.log`
     (single combined file; `logs/` created on install), then
     `launchctl bootout gui/<uid> <plist>` (ignore failure) followed by
     `launchctl bootstrap gui/<uid> <plist>`.
   - systemd: write unit with `[Service] Restart=on-failure`,
     `[Install] WantedBy=default.target`, then `systemctl --user
     daemon-reload` and `systemctl --user enable --now <name>`.
     Also run `loginctl enable-linger <user>` so the service survives
     logout — if that fails, warn and continue (install still succeeds).
5. **Idempotent:** re-running install overwrites the unit and restarts the
   service.

## Other verbs

- **uninstall:** stop + disable (`launchctl bootout` / `systemctl --user
  disable --now`), delete the unit file, remind that `$AMTP_HOME` and logs are
  untouched. Uninstalling a non-installed service is a no-op with a notice.
- **start/stop/restart:** thin wrappers over `launchctl kickstart`/`bootout`
  + `bootstrap` and `systemctl --user start/stop/restart`. Error clearly if
  the unit file does not exist ("not installed — run `amtp service install`").
- **status:** report `{installed, running, pid, name, unitPath, home,
  execStart}`. Running/pid via `launchctl print gui/<uid>/<label>` (parse) or
  `systemctl --user show <name> --property=ActiveState,MainPID`. Human table
  by default, raw object under `--json`.
- **logs:** launchd → tail `$AMTP_HOME/logs/serve.log` (`-n` lines, `-f`
  follow); systemd → exec `journalctl --user -u <name>` with matching flags.

## Unsupported platforms

Windows, or a Linux where `systemctl --user` is unusable (no systemd, no user
bus): every verb fails with a message that includes the exact command + env to
supervise manually, e.g.
`AMTP_HOME=<home> <bin> serve`.

## Architecture

```
node/src/commands/service.ts        commander wiring (verbs → manager calls)
node/src/service/                   (new dir)
  name.ts                           deriveServiceName(home), pure
  exec-resolve.ts                   resolveServeCommand({execPath, argv, binOverride}), pure
  launchd.ts                        plist template + LaunchdManager
  systemd.ts                        unit template + SystemdManager
  manager.ts                        ServiceManager interface + platform pick
```

`ServiceManager` methods (`install/uninstall/start/stop/restart/status/logs`)
shell out through an injected `run(cmd, args)` function so tests never touch
the real `launchctl`/`systemctl`.

## Testing

Follows the existing per-command test pattern (`service.test.ts` +
`node/src/service/*.test.ts`):

- Pure unit tests: name derivation (default home, weird basenames, hash
  stability), executable resolution (compiled vs bun-shim vs `--bin`), plist
  and unit file generation (snapshot the generated text, assert AMTP_HOME and
  ExecStart lines).
- Verb tests with a fake `run` recorder: install invokes bootstrap/enable in
  order, uninstall is a no-op when not installed, status parses canned
  `launchctl print` / `systemctl show` output, unsupported-platform errors.

No CI integration test against real launchd/systemd.

## Docs

- `docs/quickstart.md`: new section after step 2 ("Start both receive
  hosts") — "Run it as a persistent service" showing
  `amtp service install`, `status`, `logs`, `uninstall`, and noting
  config.json + `service restart` for port changes.
- `node/SKILL.md`: add the `service` verb group to the command reference.

## Out of scope (YAGNI)

- System-level services (LaunchDaemons, `/etc/systemd/system`, `--system`).
- Windows service manager support.
- Baking serve flags into the unit.
- Log rotation for `$AMTP_HOME/logs/serve.log`.
