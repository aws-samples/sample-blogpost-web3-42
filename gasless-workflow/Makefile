build-ValidateAndCheckFunction:
	$(MAKE) build-function NAME=validate-and-check

build-PrepareSponsorshipFunction:
	$(MAKE) build-function NAME=prepare-sponsorship

build-PrepareUserOpFunction:
	$(MAKE) build-function NAME=prepare-user-op

build-SubmitUserOpFunction:
	$(MAKE) build-function NAME=submit-user-op

build-function:
	mkdir -p $(ARTIFACTS_DIR)
	npx esbuild ./functions/$(NAME)/index.mjs --bundle --minify --platform=node --target=node24 --outfile=$(ARTIFACTS_DIR)/index.mjs --format=esm --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
