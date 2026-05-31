# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-30

### Added
- HTTP health check endpoint at `/health`
- Graceful shutdown with SIGTERM/SIGINT handling
- Server-side heartbeat (WebSocket ping/pong) for stale connection detection
- `WELCOME` message sent to clients on connect with daemon capabilities
- `HISTORY` message type to retrieve recent prompt history
- Prompt length validation (max 10,000 characters)
- VS Code CLI availability check at startup with clear warning
- Command timeout (30s) to prevent hung subprocesses
- Uptime and total prompts tracking in status updates
- Makefile for common development commands
- Docker support (Dockerfile + docker-compose.yml)
- CONTRIBUTING.md with development guidelines
- CODE_OF_CONDUCT.md (Contributor Covenant)
- GitHub issue and PR templates
- `.editorconfig` for consistent formatting

### Changed
- Daemon now uses `datetime.now(timezone.utc)` instead of deprecated `datetime.utcnow()`
- Status updates include `uptime`, `total_prompts`, `vscode_available` fields
- Improved logging format with timestamps
- Removed `path` parameter from `handle_connection` (websockets 11.x API)
- README rewritten for open-source readiness with badges, FAQ, architecture diagram

### Fixed
- `create_subprocess_exec` no longer passes `shell=True` on Windows (conflicting args)
- Status stream no longer silently swallows non-ConnectionClosed exceptions

## [1.0.0] - 2026-05-30

### Added
- Initial release
- Async WebSocket daemon (`backend/daemon.py`)
- Mobile-first web UI (`frontend/`)
- Responsive CSS with dark mode support
- WebSocket client with localStorage URL persistence
- Activity log with 50-entry cap
- Setup and launcher scripts (`scripts/`)
- Environment configuration (`config/.env.example`)
- Comprehensive documentation (Architecture, Deployment)
- MIT License

[Unreleased]: https://github.com/atodkar/vstunnel/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/atodkar/vstunnel/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/atodkar/vstunnel/releases/tag/v1.0.0
