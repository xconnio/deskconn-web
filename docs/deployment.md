# Configuration and deployment

The web app needs a DeskConn Hub with WebTransport enabled. Account-based use
also needs the management service and database. See DeskConn's
[self-hosting guide](https://github.com/xconnio/deskconn/blob/main/docs/self-hosting.md)
for the local stack.

## Configuration

For Vite development, copy `.env.example` to `.env.local` and edit its values.

| Variable | Purpose |
| --- | --- |
| `VITE_WAMP_WT_URL` | Hub WebTransport endpoint; defaults to `https://localhost:8082/wamp` |
| `VITE_WAMP_WT_CERT_URL` | Certificate-hash endpoint for a self-signed Hub certificate; leave empty for a certificate trusted by the browser |
| `VITE_WAMP_REALM` | Shared realm; defaults to `com.deskconn` |
| `VITE_REGISTRATION_AUTHID` | Registration identity; defaults to `deskconn-web-app` |
| `VITE_REGISTRATION_PRIVATE_KEY` | Key matching the deployment's registration identity; embedded at build time |

The registration key is delivered in the browser bundle, so it is not a
server-side secret. The Hub must restrict that identity to its intended
registration operations. The example identity must match your local deployment.

Connection settings are read from `window.__APP_CONFIG__`, then Vite's build-time
environment, then the defaults in `src/config.defaults.ts`. The registration
private key is build-time only and cannot be replaced through runtime config.

## Local certificates

The local Hub can expose a self-signed WebTransport certificate's hash at
`http://localhost:8083/wt-cert-hash`. Browser support for certificate hashes varies;
if your browser cannot connect this way, use a locally trusted certificate.

The Makefile documents a `mkcert` setup. Generate and trust the certificate,
configure the Hub's `DESKCONN_ROUTER_QUIC_TLS_CERT` and
`DESKCONN_ROUTER_QUIC_TLS_KEY`, then run:

```sh
make dev-local-mkcert
```

This clears the certificate-hash URL and uses normal browser certificate trust.
Standalone WebTransport connections also require a certificate trusted by the
browser; that connection path does not configure certificate hashes.

## Production builds

```sh
npm ci
npm run build
```

Serve the generated `dist/` files over HTTPS, with history fallback to
`index.html` for application routes. Serve `config.js` with
`window.__APP_CONFIG__` if using runtime overrides, and make the emitted WASM
and `sw-download.js` assets available. For a build without runtime overrides,
`config.js` may contain `window.__APP_CONFIG__ = {};`.

## Docker

The Dockerfile builds the app and serves it through nginx. To build a local
image with a registration key supplied by your deployment:

```sh
export VITE_REGISTRATION_PRIVATE_KEY='your-registration-key'
docker build --build-arg VITE_REGISTRATION_PRIVATE_KEY -t deskconn-web:local .
```

The included Compose file uses the published
`xconnio/deskconn-web-app:latest` image and reads `.env.local`:

```sh
docker compose up -d web
```

It listens on `127.0.0.1:3000`; open `http://localhost:3000/login` for local use.
The container entrypoint generates `config.js` from the four runtime variables
listed above, excluding the registration private key. Changing that key requires
rebuilding the image. A local image build does not change which image Compose
runs; override its image explicitly when testing your own build.

The supplied nginx configuration is designed for the DeskConn deployment's
route layout. For another domain or reverse proxy, ensure application routes,
assets, `config.js`, and `/sw-download.js` are forwarded correctly.
