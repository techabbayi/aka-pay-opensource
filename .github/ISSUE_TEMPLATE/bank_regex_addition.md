---
name: Bank Notification Format / Regex Addition
about: Request or propose support for a new Indian bank's SMS or Email alert format
title: '[BANK-SUPPORT]: '
labels: ['bank-parser', 'parsers']
assignees: ['techabbayi']
---

### Bank Name & Institutional Information
- **Bank Name**: (e.g., Union Bank of India, Canara Bank, IndusInd Bank, Federal Bank)
- **Official Domain / Sender ID**: (e.g., `*.bank.in`, `alerts@unionbankofindia.bank.in`, `VM-UBINB`)
- **NPCI Handle / UPI Suffix**: (e.g., `@unionbank`, `@cnrb`, `@indus`)

---

### Verbatim Sample Alert (REDACTED)
> **CRITICAL**: Completely redact account numbers, customer names, phone numbers, and private balances. Replace with placeholder `XXXX1234`!

#### SMS Sample:
```text
Dear Customer, your A/C XXXX1234 is credited with INR 499.00 on 04-Nov-26 by UPI/123456789012/REF... Available Bal: Rs.XXXX. -Union Bank
```

#### Email Alert Header & Subject (if applicable):
```text
From: alerts@bankname.bank.in
Subject: Credit alert for your Account XXXX1234
Body: ...
```

---

### Extracted Field Verification
- **Expected Amount**: `499.00`
- **Expected UTR / Bank Reference (12 Digits)**: `123456789012`
- **Expected Sender VPA (if present)**: `payer@oksbi`
- **Expected Account Number Ending**: `1234`

---

### Regulatory Verification
- [ ] Verified against **RBI / IDRBT `.bank.in` / `.fin.in` institutional domain directives**.
- [ ] Confirmed format with actual production bank notification telemetry.

