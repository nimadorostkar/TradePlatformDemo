# TradePlatform gateway — developer tasks.

BINARY      := gateway
PKG         := ./...
CMD         := ./cmd/gateway
BIN_DIR     := bin
DOCKER_IMG  := tradeplatform-gateway

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: tidy
tidy: ## go mod tidy
	go mod tidy

.PHONY: build
build: ## Build the gateway binary into bin/
	@mkdir -p $(BIN_DIR)
	go build -o $(BIN_DIR)/$(BINARY) $(CMD)

.PHONY: build-windows
build-windows: ## Cross-compile a static Windows amd64 exe (for the native VPS deploy)
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BIN_DIR)/gateway.exe $(CMD)

.PHONY: build-linux
build-linux: ## Cross-compile a static Linux amd64 binary
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BIN_DIR)/gateway-linux $(CMD)

.PHONY: run
run: ## Run the gateway locally
	go run $(CMD)

.PHONY: test
test: ## Run unit tests
	go test $(PKG)

.PHONY: test-race
test-race: ## Run unit tests with the race detector
	go test -race $(PKG)

.PHONY: vet
vet: ## go vet
	go vet $(PKG)

.PHONY: fmt
fmt: ## Format the code
	gofmt -s -w .

.PHONY: lint
lint: ## Run golangci-lint if installed
	@command -v golangci-lint >/dev/null 2>&1 && golangci-lint run || echo "golangci-lint not installed; skipping"

.PHONY: check
check: fmt vet test ## Format, vet, and test

.PHONY: docker-build
docker-build: ## Build the container image
	docker build -f deploy/docker/Dockerfile -t $(DOCKER_IMG):dev .

.PHONY: compose-up
compose-up: ## Start the local stack (gateway + postgres/timescale + redis + nats)
	docker compose -f deploy/compose/docker-compose.yml up --build

.PHONY: compose-down
compose-down: ## Stop the local stack
	docker compose -f deploy/compose/docker-compose.yml down -v
