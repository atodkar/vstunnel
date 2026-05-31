# vstunnel Documentation

Welcome to the vstunnel documentation. Choose the guide that matches your needs.

---

## For Users

### [User Guide](USER_GUIDE.md)

Step-by-step instructions for installing and using vstunnel to control GitHub Copilot from your phone. No programming knowledge required.

Covers:
- What you need (prerequisites)
- Installation (one-time setup)
- Starting a session (4 simple steps)
- Sending prompts from your phone
- Understanding status updates
- Troubleshooting common issues
- Tips and best practices

---

## For Developers

### [Developer Guide](DEVELOPER_GUIDE.md)

Complete onboarding guide for developers seeing this codebase for the first time. Explains how to set up the dev environment, how the code works, and how to make changes.

Covers:
- Step-by-step dev environment setup
- Project structure walkthrough
- How each component works (backend, frontend, transport)
- Running locally (3 methods)
- Making changes (backend, frontend, new message types)
- Testing and debugging
- Architecture decisions and rationale

### [Architecture](ARCHITECTURE.md)

Deep technical reference covering protocols, data flow, security model, and performance characteristics.

Covers:
- System diagram and component breakdown
- WebSocket message protocol specification
- VS Code CLI integration details
- Security threat model and mitigations
- Performance profile and scalability limits
- Error handling strategies

### [Deployment](DEPLOYMENT.md)

Production deployment options for various environments.

Covers:
- Docker / docker-compose
- systemd (Linux always-on)
- launchd (macOS always-on)
- Windows Task Scheduler
- Vercel/Netlify (frontend hosting)
- Health monitoring and logging

---

## Quick Links

| I want to... | Go to |
|------|-------|
| Use vstunnel on my phone | [User Guide](USER_GUIDE.md) |
| Set up a dev environment | [Developer Guide](DEVELOPER_GUIDE.md) |
| Understand the architecture | [Architecture](ARCHITECTURE.md) |
| Deploy to production | [Deployment](DEPLOYMENT.md) |
| Contribute code | [Contributing](../CONTRIBUTING.md) |
| Report a bug | [Bug Template](../.github/ISSUE_TEMPLATE/bug_report.md) |
| Request a feature | [Feature Template](../.github/ISSUE_TEMPLATE/feature_request.md) |
