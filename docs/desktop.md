# Desktop app

The desktop app is the same client packaged with Electron. It loads the
unmodified `dist/` build from an `app://deskconn` origin, so WebTransport,
WebRTC, IndexedDB, and the download service worker behave as in Chrome, with no
browser required. The Electron entry point is [electron/main.js](../electron/main.js).

## Install

Download the file for your platform from
[Releases](https://github.com/xconnio/deskconn-web/releases):

| Platform | File | Notes |
|---|---|---|
| Linux (Debian/Ubuntu) | `.deb` | `sudo apt install ./deskconn-desktop-*.deb`, then run `deskconn-desktop` |
| Linux (other) | `.AppImage` | `chmod +x`, then run it. On Ubuntu 23.10+ use the `.deb` instead |
| macOS | `.dmg` (`arm64` for Apple Silicon, `x64` for Intel) | Unsigned: allow it in System Settings → Privacy & Security |
| Windows | `.exe` installer | Unsigned: SmartScreen → More info → Run anyway |

On Ubuntu 23.10 and later the AppImage exits on launch with a "SUID sandbox
helper binary" error, because AppArmor restricts the user namespaces Electron's
sandbox needs. The `.deb` is not affected.

## Configuration

Hub settings are baked in at build time from the same `VITE_*` variables as the
web build. To point an installed app at another Hub, create `config.json` in
the app's data directory with any of `WAMP_WT_URL`, `WAMP_WT_CERT_URL`,
`WAMP_REALM`, and `REGISTRATION_AUTHID`:

- Linux: `~/.config/DeskConn/config.json`
- macOS: `~/Library/Application Support/DeskConn/config.json`
- Windows: `%APPDATA%\DeskConn\config.json`

```json
{ "WAMP_WT_URL": "https://hub.example.com:8082/wamp" }
```

## Development and packaging

```sh
make run-desktop     # Vite dev server inside Electron, with hot reload
make build-desktop   # dist/ + installers for the current OS in release/
```

`build-desktop` produces an AppImage and `.deb` on Linux, `.dmg` files on macOS,
and an NSIS installer on Windows. Each platform must be built on that OS; see
[package.json](../package.json) `build` for the electron-builder settings.
