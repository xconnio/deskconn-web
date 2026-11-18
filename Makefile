IMAGE := xconnio/deskconn-web-app
VERSION := $(shell git describe --tags --always)

setup:
	npm install

build:
	npm run build

run:
	npm run dev

run-desktop:
	npm run electron:dev

build-desktop:
	npm run electron:build

dev-local:
	VITE_WAMP_WT_URL=https://localhost:8082/wamp \
	VITE_WAMP_WT_CERT_URL=http://localhost:8083/wt-cert-hash \
	npm run dev

# dev-local-mkcert: use a mkcert-generated cert so Firefox works too.
# One-time setup:
#   sudo apt install mkcert (or: go install filippo.io/mkcert@latest)
#   mkcert -install
#   mkcert -cert-file wt.pem -key-file wt-key.pem localhost 127.0.0.1 ::1
# Then set in the router .env:
#   DESKCONN_ROUTER_QUIC_TLS_CERT=<abs-path>/wt.pem
#   DESKCONN_ROUTER_QUIC_TLS_KEY=<abs-path>/wt-key.pem
dev-local-mkcert:
	VITE_WAMP_WT_URL=https://localhost:8082/wamp \
	VITE_WAMP_WT_CERT_URL= \
	npm run dev

clean:
	rm -rf dist/ release/ node_modules/

DOCKER_BUILD := docker buildx build --build-arg VITE_REGISTRATION_PRIVATE_KEY -t $(IMAGE):$(VERSION) -t $(IMAGE):latest

build-docker:
	$(DOCKER_BUILD) --platform linux/amd64,linux/arm64 .

build-docker-amd64:
	$(DOCKER_BUILD) --platform linux/amd64 .

build-docker-arm64:
	$(DOCKER_BUILD) --platform linux/arm64 .

push-docker:
	@[ "$$CI" = true ] || { echo "push-docker only runs in CI"; exit 1; }
	$(DOCKER_BUILD) --platform linux/amd64,linux/arm64 --push .

run-docker:
	docker compose up web
