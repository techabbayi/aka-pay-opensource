---
name: Bug Report
about: Create a report to help us improve AKA PAY
title: '[BUG]: '
labels: ['bug', 'triage']
assignees: ['techabbayi']
---

### Prerequisites
- [ ] I have read the [Contributing Guidelines](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md).
- [ ] I have searched existing issues to ensure this bug has not already been reported.
- [ ] This report contains **NO real bank credentials, API keys, customer phone numbers, or private tokens**.

---

### Component / Service Affected
<!-- Select one or more -->
- [ ] Payment Core REST API (Port 6100)
- [ ] Checkout Portal & Modal (`akapay.js` / Port 7000)
- [ ] Merchant Admin & Landing Page (Port 6001)
- [ ] SMS Observer (Port 6002) / Android Companion App
- [ ] Gmail Observer (Port 6003)
- [ ] Cashier POS Desk (`/counter`) / Stand Studio
- [ ] Core Engine / Database (`@akapay/core`, `@akapay/db`)

---

### Describe the Bug
<!-- A clear and concise description of what the bug is. -->

### Steps to Reproduce
1. Start service: `...`
2. Perform action: `...`
3. Trigger endpoint or observer: `...`
4. Observe error or unexpected behavior.

### Expected Behavior
<!-- What you expected to happen according to payment lifecycle invariants. -->

### Actual Behavior / Logs
<!-- Paste relevant non-sensitive logs or screenshot below -->
```text

```

### Environment
- **Node.js Version**: (e.g., `node -v` -> `v24.22.1`)
- **OS**: (e.g., Ubuntu 24.04, Windows 11, macOS Sequoia)
- **Browser** (if frontend bug): (e.g., Chrome 130, Firefox 132, Safari 18)
- **Database Mode**: SQLite WAL (default)

---

### Additional Context
<!-- Any other context or details about the problem. -->

