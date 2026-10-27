# .

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd) 
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

The app installs `@xconnio/core` from npm, including its compiled WASM.
A Core source checkout and Rust toolchain are not needed to build the app.

```sh
npm ci
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

## Transport regression tests

The app uses `@xconnio/core` for WAMP, codecs, authentication, WebTransport,
and WebRTC. Browser networking remains browser-native; Rust/WASM owns protocol
state and codecs. App adapters retain DeskConn RPC call sites and encrypted
shell/file record formats. Closing a direct session keeps borrowed relay signaling
alive; closing an owned relay session closes its connection.

Use Node 22.22.2+, 24.15.0+, or 26+ for the transport test runner. Build Core's local peer and run the real Chromium tests:

```sh
cargo build --manifest-path ../xconn-core/Cargo.toml --locked \
  -p xconn-binding-runtime --all-features --example transport_peer
CHROMIUM_BIN=/path/to/chrome \
XCONN_TRANSPORT_PEER="$PWD/../xconn-core/target/debug/examples/transport_peer" \
  npm run test:transports
```

The tests use only local endpoints and cover RPC payloads, progressive results,
shared connection ownership, relay bytes/cancellation, and full-size raw WebRTC packets.
`npm run build` also verifies TypeScript and emits the Core WASM as a Vite asset.
