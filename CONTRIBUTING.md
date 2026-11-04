# Contributing to AKA PAY

Thank you for your interest in contributing to **AKA PAY** (*UPI & Payment Infrastructure, Also Known As. Always Connected.*).

AKA PAY is a self-hosted, sovereign, zero-fee UPI payment gateway designed for peer-to-peer (P2P / P2M) settlement, automated banking observation (SMS & Gmail), and counter payments.

---

## 1. Project Ownership & Open Source Governance

* **Author & Lead Maintainer:** [techabbayi](https://github.com/techabbayi) (Lokeswara Muthumula)
* **GitHub Repository:** [https://github.com/techabbayi/aka-pay-opensource](https://github.com/techabbayi/aka-pay-opensource)
* **LinkedIn:** [https://in.linkedin.com/in/lokeswaramuthumula](https://in.linkedin.com/in/lokeswaramuthumula)
* **Email:** [srssltd@gmail.com](mailto:srssltd@gmail.com)
* **License:** [Apache License 2.0](./LICENSE)

All contributors are expected to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 2. Monorepo Architecture & Service Topology

AKA PAY is structured as an npm workspaces monorepo:

```
├── apps/
│   ├── checkout-portal/     # Serves akapay.js SDK, iframe /checkout/:id, API proxy (Port 7000)
│   ├── coin-wallet-store/   # Reference merchant implementation & test store (Port 5000)
│   ├── control-center/      # Supervisor process manager daemon (Port 8090)
│   ├── gmail-observer/      # Gmail OAuth & polling observation ingester (Port 6003)
│   ├── merchant-admin/      # Sovereign Landing Page & Merchant Hub Cockpit (Port 6001)
│   ├── payment-api/         # Core payment engine, state machine, outbox queue (Port 6100)
│   ├── payment-help/        # Help center & documentation portal
│   └── sms-observer/        # Android SMS webhook ingester (Port 6002)
├── packages/
│   ├── common/              # Shared cryptographic utilities, HMAC signing, env resolution
│   ├── core/                # Payment state machine, bank regex parsers, attribution engine
│   ├── db/                  # SQLite native WAL driver, schemas, and repositories
│   └── merchant-sdk/        # Universal client-side akapay.js integration bundle
└── scripts/                 # Supervisor launch scripts, test suites, and APK builder
```

### Standard Service Ports:

| Service | Port | Description |
| :--- | :--- | :--- |
| **Coin Wallet Demo Store** | `5000` | Merchant showcase store demonstrating universal 1-script integration |
| **Payment Core REST API** | `6100` | State machine, session reservation, deduplication, webhook outbox |
| **Checkout Portal** | `7000` | Dynamic vector QR, UPI intent launcher, event bridge |
| **Merchant Admin** | `6001` | Sovereign landing page (`/`), Merchant Hub (`/admin`), Cashier POS (`/counter`) |
| **SMS Observer** | `6002` | Android SMS observer webhook receiver |
| **Gmail Observer** | `6003` | Push notification and Gmail API mailbox poller |
| **Control Center** | `8090` | Local process supervisor daemon |

---

## 3. Local Development Setup

### Prerequisites
- **Node.js >= 24.22.1** (Active LTS "Krypton" with built-in `node:sqlite`).
- **npm >= 10.x**

### Quickstart

1. **Clone the repository:**
   ```bash
   git clone https://github.com/techabbayi/aka-pay-opensource.git
   cd aka-pay-opensource
   ```

2. **Install monorepo dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   *(Defaults in `.env.example` work out of the box for local development).*

4. **Initialize database schema:**
   ```bash
   npm run db:setup
   ```

5. **Start all services via supervisor:**
   ```bash
   npm run dev
   ```

Once running:
- **Sovereign Landing & Setup Wizard**: [http://localhost:6001](http://localhost:6001)
- **Demo Store**: [http://localhost:5000](http://localhost:5000)
- **Control Center Supervisor**: [http://localhost:8090](http://localhost:8090)

---

## 4. Mandatory Git Workflow & Branching Rules

1. **NEVER make direct commits to `main`**.
2. **Branch Directly Off Current Active Working Branch**:
   - Features: `feature/<feature-name>` (e.g., `feature/axis-bank-upi-regex`)
   - Fixes: `fix/<issue-name>` (e.g., `fix/inbound-email-timeout`)
3. **Mandatory Conventional Commits Standard**:
   Every commit must follow Conventional Commits formatting:
   - `feat(...)` — New features or observation modes
   - `fix(...)` — Bug fixes or edge-case resolutions
   - `perf(...)` — Performance improvements
   - `refactor(...)` — Refactoring without behavior change
   - `docs(...)` — Documentation changes
   - `test(...)` — Adding or correcting tests
   - `ci(...)` — CI/CD workflow updates
   - `chore(...)` — Maintenance and dependencies
4. **Pre-Push Verification Checklist**:
   Before pushing or requesting review, always ensure:
   - `npm run typecheck` passes with 0 TypeScript errors.
   - `npm test` passes 100% cleanly across all 59 curated test suites.
   - `git diff` contains no secrets, tokens, or debug print statements.

---

## 5. How to Add a New Bank's Notification Pattern

Adding support for a new Indian bank (e.g., Union Bank of India, Canara Bank, IndusInd, Federal Bank) is one of the most impactful open source contributions:

1. **Open an Issue First**:
   Use the **Bank Notification Format** issue template. Provide a verbatim sample alert with all account numbers, balances, and customer names redacted (`XXXX1234`).

2. **Locate the Parser**:
   - SMS alert regex: [`packages/core/src/parser/bank-sms.parser.js`](./packages/core/src/parser/bank-sms.parser.js)
   - Email alert regex: [`packages/core/src/parser/bank-email.parser.js`](./packages/core/src/parser/bank-email.parser.js)

3. **Implement the Pattern**:
   Ensure your regex extracts:
   - `amount` (down to the paisa)
   - `utr` (standard 12-digit bank reference number)
   - `accountEnding` (4 digits)
   - `senderVpa` (if included by the bank)

4. **Add Real Test Cases**:
   Add test coverage with authentic format variations in [`packages/core/src/__tests__/`](./packages/core/src/__tests__/).

5. **Verify Standards**:
   - Check against **RBI / IDRBT `.bank.in` domain directives**.
   - Ensure the regex does not throw catastrophic backtracking (ReDoS).

---

## 6. Frontend & UI Design Standards

To preserve the sovereign, institutional fintech aesthetic:
- **100% Bank-Grade Light Theme**: All pages, modals, and drawers must adhere to clean light-theme variables (`--theme: light;`). No dark theme remnants, dark flash, or harsh gradients.
- **Zero Unicode Emojis**: Always use precision SVG stroke icons (`<svg class="i"><use href="#i-..."/>`) and CSS status dots (`<span class="dot dot-green"></span>`). Never commit raw emoji characters into UI views.

---

## 7. Security Invariants

When contributing backend or API modifications, respect these four unbreakable invariants:
1. **No Public Force-Success Endpoint**: A payment session can ONLY transition to `SUCCESS` via verified banking observation matching or cashier desk confirmation.
2. **Raw-Body HMAC Computation**: Webhook signatures (`X-Gateway-Signature`) MUST be computed over the unparsed raw request bytes.
3. **Idempotency & UTR Deduplication**: Replayed bank reference numbers must be deduplicated via SQLite `UNIQUE(bank_reference_number)` constraints.
4. **PII Isolation**: Customer phone numbers and bank credentials must never be logged or exposed to client-side scripts.

---

## 8. Submitting a Pull Request

1. Ensure all tests pass:
   ```bash
   npm run typecheck
   npm test
   ```
2. Push your feature branch:
   ```bash
   git push origin feature/<your-feature>
   ```
3. Open a Pull Request using GitHub CLI or the web UI. Complete the [Pull Request Template](./.github/pull_request_template.md).
4. Automated CI workflows will run automated linting, security scanning, and test verification. Address any automated suggestions or maintainer feedback promptly.

Thank you for helping build sovereign, zero-fee payment infrastructure!
