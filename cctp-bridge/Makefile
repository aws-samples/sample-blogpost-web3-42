build-ValidateBridgeRequestFunction:
	$(MAKE) build-function NAME=validate-bridge-request

build-PrepareBridgeCallsFunction:
	$(MAKE) build-function NAME=prepare-bridge-calls

build-GetAttestationFunction:
	$(MAKE) build-function NAME=get-attestation

build-PrepareReceiveCallFunction:
	$(MAKE) build-function NAME=prepare-receive-call

build-function:
	mkdir -p $(ARTIFACTS_DIR)
	npx esbuild ./functions/$(NAME)/index.mjs --bundle --minify --platform=node --target=node24 --outfile=$(ARTIFACTS_DIR)/index.mjs --format=esm --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
