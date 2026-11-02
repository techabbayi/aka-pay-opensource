# Contributing to AKA PAY

Thank you for your interest in contributing to **AKA PAY** (*UPI & Payment Infrastructure, Also Known As. Always Connected.*).

---

## Project & Maintainer Details

* **Author / Maintainer:** techabbayi (Lokeswara Muthumula)
* **GitHub Profile:** [techabbayi](https://github.com/techabbayi)
* **Repository:** [techabbayi/aka-pay-opensource](https://github.com/techabbayi/aka-pay-opensource)
* **LinkedIn:** [Lokeswara Muthumula](https://in.linkedin.com/in/lokeswaramuthumula)
* **Email:** [srssltd@gmail.com](mailto:srssltd@gmail.com)

---

## Code of Conduct & Standards

Please refer to [`AGENTS.md`](./AGENTS.md) for mandatory architectural rules, Git workflows, security standards, and payment lifecycle invariants.

### Key Rules:
1. **Never make direct commits to `main`**.
2. Create dedicated feature branches (`feature/<name>`) or fix branches (`fix/<name>`).
3. Maintain 100% test passing status across all test suites (`npm test`).
4. Follow Conventional Commits: `feat(...)`, `fix(...)`, `perf(...)`, `refactor(...)`, `docs(...)`, `test(...)`, `chore(...)`.
5. Never log or store raw secrets, customer PINs, or unencrypted tokens.

---

## Running Tests Locally

```bash
# Run all unit and regression tests
npm test

# Run TypeScript typechecks
npm run typecheck
```

---

## Reporting Issues & Disclosures

* **Issues & Feature Requests:** Please open an issue at [GitHub Issues](https://github.com/techabbayi/aka-pay-opensource/issues).
* **Security Advisories:** For responsible security vulnerability disclosures, email [srssltd@gmail.com](mailto:srssltd@gmail.com) directly.

---

## License

By contributing to AKA PAY, you agree that your contributions will be licensed under the [Apache-2.0 License](./LICENSE).
