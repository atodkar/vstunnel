# Contributing to vstunnel

Thanks for your interest in contributing! This document explains how to get involved.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Style Guide](#style-guide)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold a welcoming, inclusive environment.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/atodkar/vstunnel.git
   cd vstunnel
   ```
3. **Create a branch** for your work:
   ```bash
   git checkout -b feature/your-feature-name
   ```

---

## Development Setup

### Backend

```bash
# Create and activate virtual environment
python3 -m venv backend/venv
source backend/venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Install dev dependencies
pip install pytest pytest-asyncio black flake8

# Run the daemon
python backend/daemon.py
```

### Frontend

The frontend has no build step. Open `frontend/index.html` directly or serve it:

```bash
cd frontend
python3 -m http.server 3000
# Open http://localhost:3000
```

### Full stack (via Make)

```bash
make setup    # Install everything
make run      # Start daemon
make lint     # Check code style
make test     # Run tests
make clean    # Remove generated files
```

---

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feature/auto-reconnect` — new functionality
- `fix/websocket-timeout` — bug fix
- `docs/deployment-guide` — documentation
- `refactor/daemon-state` — code improvement

### Commit Messages

Write clear, concise commit messages:

```
feat: add auto-reconnect to mobile UI

The WebSocket client now retries with exponential backoff when
the connection drops, up to a maximum of 5 attempts.
```

Prefix with: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

### What We Look For

- **Focused PRs**: One logical change per PR. If you fix a bug and add a feature, submit them separately.
- **Tests**: Add tests for new backend logic. Frontend testing is welcome but not required yet.
- **No unnecessary dependencies**: This project values minimal footprint. Justify any new dependency.
- **Cross-platform**: Changes should work on Linux, macOS, and Windows unless platform-specific by nature.

---

## Pull Request Process

1. Ensure your code passes linting:
   ```bash
   make lint
   ```

2. Update documentation if your change affects user-facing behavior.

3. Fill out the PR template completely.

4. Request review. A maintainer will respond within a few days.

5. Address feedback. Push additional commits (don't force-push during review).

6. Once approved, a maintainer will merge your PR.

---

## Style Guide

### Python (Backend)

- **Formatter**: [Black](https://github.com/psf/black) with default settings.
- **Linter**: flake8 with max line length 100.
- **Type hints**: Encouraged for function signatures.
- **Async**: Use `async/await` throughout. No blocking I/O in the event loop.

```python
async def handle_message(data: dict) -> dict:
    prompt = data.get("payload", "").strip()
    if not prompt:
        return {"type": "ERROR", "message": "Empty prompt"}
    return await execute_vscode_command(prompt)
```

### JavaScript (Frontend)

- **No framework**: Vanilla JS. Keep it that way.
- **ES6+**: Use classes, arrow functions, template literals, `const`/`let`.
- **No build step**: Code must run directly in the browser without transpilation.
- **Semicolons**: Yes.
- **Indent**: 4 spaces.

### CSS

- **Methodology**: BEM-inspired class names where helpful, but not strict.
- **Variables**: Use CSS custom properties (`var(--primary-color)`).
- **Mobile-first**: Base styles for mobile, `@media` queries for larger screens.

### Documentation

- Use Markdown.
- Keep line length under 120 characters.
- Use code fences with language identifiers.
- Prefer concrete examples over abstract descriptions.

---

## Reporting Bugs

Open a [GitHub Issue](../../issues/new?template=bug_report.md) with:

1. **What you expected** to happen.
2. **What actually happened** (include error output).
3. **Steps to reproduce**.
4. **Environment**: OS, Python version, VS Code version, browser.

---

## Suggesting Features

Open a [GitHub Issue](../../issues/new?template=feature_request.md) with:

1. **The problem** you're trying to solve.
2. **Your proposed solution** (if any).
3. **Alternatives** you considered.

We prioritize features that align with the project's core principles: privacy-first, zero-cost, minimal footprint.

---

## Areas for Contribution

Here are high-impact areas where we especially welcome help:

| Area | Difficulty | Description |
|------|-----------|-------------|
| Unit tests | Easy | Add pytest tests for daemon message handling |
| Accessibility | Easy | Improve mobile UI ARIA labels and keyboard nav |
| i18n | Medium | Internationalize the frontend strings |
| Alternative editors | Medium | Support Cursor, VSCodium, code-server |
| PWA support | Medium | Make the mobile UI installable as a PWA |
| E2E tests | Hard | Playwright tests for the full mobile → daemon flow |
| Authentication | Hard | Optional passcode/token auth layer for the WebSocket |

---

## Questions?

If something isn't clear, open a Discussion or ask in an issue. We're happy to help new contributors get oriented.

Thank you for helping make vstunnel better!
