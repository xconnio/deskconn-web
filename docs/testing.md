# Testing

Install the app dependencies with `npm ci` before running these commands.

## Static checks

```sh
npm run type-check
npx eslint .
npm run build
```

`npm run lint` applies fixes; `npx eslint .` checks without changing files.
The production build also verifies TypeScript and emits the XConn WASM asset.

## Browser transport tests

The transport runner launches real headless Chromium against local endpoints.
Set `CHROMIUM_BIN` to an installed Chromium or Chrome executable. Use a supported
Node.js version from `package.json`.

Unlike ordinary app builds, this test fixture requires a Rust toolchain and an
XConn source checkout. With that checkout at `../xconn`, run from the web repo:

```sh
cargo build --manifest-path ../xconn/Cargo.toml --locked \
  -p xconn-binding-runtime --all-features --example transport_peer
CHROMIUM_BIN=/path/to/chrome \
XCONN_TRANSPORT_PEER="$PWD/../xconn/target/debug/examples/transport_peer" \
  npm run test:transports
```

The tests cover RPC payloads, progressive results, connection ownership,
relay bytes/cancellation, and full-size raw WebRTC packets. They use loopback
endpoints; they do not establish real-world NAT traversal coverage.

## DeskConn feature interoperability

These tests run actual DeskConn file and shell handlers behind the local yamux
application connection and an RPC bridge. Feature traffic uses RPC-associated
streams with the same encryption over WebTransport and WebRTC.

With a DeskConn checkout at `../deskconn`, Go and the published XConn native SDK
installed, build the backend fixture:

```sh
(cd ../deskconn && go build -tags xconn_static \
  -o /tmp/deskconn-client-peer ./tests/client-peer)
```

Then run from the web repo:

```sh
DESKCONN_STREAM_PEER=/tmp/deskconn-client-peer \
CHROMIUM_BIN=/path/to/chrome npm run test:transports
```

The backend fixture replaces `XCONN_TRANSPORT_PEER` for this run. Tests cover
multi-megabyte encrypted uploads/downloads, concurrent shells, empty reads,
missing files, cancellation, and cleanup. See the
[fixture documentation](https://github.com/xconnio/deskconn/blob/main/tests/client-peer/README.md)
for backend setup details.
