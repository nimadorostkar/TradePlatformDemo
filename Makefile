# TradePlatformDemo — monorepo developer tasks.
#
# Each package keeps its own tooling (frontend/package.json, backend/Makefile);
# these targets just fan out so a fresh clone can be set up and verified from
# the root.

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: ## Install frontend deps and download Go modules
	cd frontend && npm ci
	cd backend && go mod download

.PHONY: dev
dev: ## Run the full stack locally against the demo market simulator (terminal on :3100)
	./scripts/dev.sh

.PHONY: backend
backend: ## Run the Go gateway locally (:5063)
	$(MAKE) -C backend run

.PHONY: frontend
frontend: ## Run the Vite dev server (:3100)
	cd frontend && npm run dev

.PHONY: build
build: ## Production build of both packages
	$(MAKE) -C backend build
	cd frontend && npm run build

.PHONY: test
test: ## Unit tests for both packages
	$(MAKE) -C backend test
	cd frontend && npm test

.PHONY: check
check: ## Full verification: legacy-ref guard + fmt/vet/test (Go) + typecheck/lint/format/test (web)
	./scripts/check-no-legacy-refs.sh
	$(MAKE) -C backend check
	cd frontend && npm run typecheck && npm run lint && npm run format:check && npm test
