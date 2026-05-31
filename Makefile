.PHONY: setup run lint test clean docker-build docker-run health frontend

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies and initialize project
	@./scripts/setup.sh

run: ## Start the vstunnel daemon
	@./scripts/start-daemon.sh

run-dev: ## Start daemon with DEBUG logging
	@source backend/venv/bin/activate && LOG_LEVEL=DEBUG python3 backend/daemon.py

frontend: ## Serve frontend on localhost:3000
	@cd frontend && python3 -m http.server 3000

lint: ## Run linters (black + flake8)
	@source backend/venv/bin/activate && \
		black --check backend/ && \
		flake8 backend/ --max-line-length=100 --ignore=E501,W503

format: ## Auto-format Python code
	@source backend/venv/bin/activate && black backend/

test: ## Run test suite
	@source backend/venv/bin/activate && pytest backend/tests/ -v

health: ## Check if daemon is running
	@curl -sf http://localhost:8080/health | python3 -m json.tool || \
		echo "Daemon is not running or not reachable on port 8080"

docker-build: ## Build Docker image
	docker build -t vstunnel:latest .

docker-run: ## Run daemon in Docker container
	docker compose up -d

docker-stop: ## Stop Docker containers
	docker compose down

clean: ## Remove generated files (venv, __pycache__, etc.)
	rm -rf backend/venv
	rm -rf backend/__pycache__
	rm -rf backend/.pytest_cache
	rm -f config/.env
	@echo "Cleaned."
