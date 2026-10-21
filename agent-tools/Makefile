build-ValidateAndAdaptTransferFunction:
	$(MAKE) build-function NAME=validate-and-adapt-transfer

build-ValidateAndAdaptBridgeFunction:
	$(MAKE) build-function NAME=validate-and-adapt-bridge

build-function:
	mkdir -p $(ARTIFACTS_DIR)
	npx esbuild ./functions/$(NAME)/index.mjs --bundle --minify --platform=node --target=node24 --outfile=$(ARTIFACTS_DIR)/index.mjs --format=esm --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
