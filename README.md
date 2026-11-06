# D5 Code

D5 Code is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code), an "agent harness control surface" for the coding agents on your machine. It adds sidebar thread folders and installs beside official T3 Code builds without sharing state.

T3 Code is MIT licensed, and its copyright notice stays in [LICENSE](./LICENSE). D5 Code is not affiliated with or endorsed by the T3 Code team.

## What keeps the T3 name

D5 Code still uses T3 Connect for remote access, which needs your T3 account. These names stay so it keeps working and so existing installs keep their data:

- The `t3` command, including `t3 connect`, the `t3.json` project file, and `T3CODE_*` variables.
- The `~/.t3-fork` state directory, `com.div0ky.t3code` bundle ID, `t3code-fork` URL scheme, and `t3code-div0ky` keychain item.
- T3 Connect itself, its relay, and `app.t3.codes` links.

The T3 Code install scripts still install upstream T3 Code. D5 Code releases carry no CLI archives yet, so `t3 update` and SSH environments have no D5 runtime to download.

## Build the desktop app

Install [`vp`](https://viteplus.dev/guide/), then:

```bash
vp i
vp run dist:desktop:d5
```

The DMG lands in `release/`. First launch offers to copy your settings from T3 Code.

## Publish an update

D5 Code has its own version and updates from this repo's GitHub Releases. Installed apps only take a higher version than their own.

1. Set the new version in `apps/desktop`, `apps/server`, `apps/web`, and `packages/contracts`.
2. Build it, then publish the build as the latest release:

```bash
vp run dist:desktop:d5
gh release create "v$VERSION" release/D5-Code-* release/latest-mac.yml --latest --generate-notes
```

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run D5 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).
