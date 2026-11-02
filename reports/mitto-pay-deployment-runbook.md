# Mitto Pay — Controlled Staging Deployment Runbook

**Target Host:** Oracle VM `130.210.28.51` (`ubuntu@130.210.28.51`)  
**Service:** `AKA PAY-staging.service` (`/etc/systemd/system/AKA PAY-staging.service`)  
**Environment File:** `/etc/AKA PAY/staging.env`  
**Deploy Path:** `/opt/aka-pay`  
**Release Artifact:** `reports/mitto-pay-rc1.tar.gz`  
**Artifact SHA-256:** `9fd6ed79082c25430d55f89590bfc09f515b54fd782bb2e97d8c4be1de18c07b`  
**Authorization Status:** PENDING EXPLICIT DEPLOYMENT APPROVAL (DO NOT EXECUTE WITHOUT AUTHORIZATION)

---

## 1. Pre-Deployment Readiness Verification

Before copying any files or modifying configuration:

1. **Verify SSH Access & Health:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "uptime && df -h / && systemctl status AKA PAY-staging.service --no-pager"
   ```
2. **Verify Backup Integrity:**
   Confirm `/opt/aka-pay-backup-pre-gate4` exists and is intact:
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "ls -la /opt/aka-pay-backup-pre-gate4/DEPLOYED_COMMIT"
   ```

---

## 2. Staging Environment Configuration Patch

Prepare `/etc/AKA PAY/staging.env` to enforce canary isolation before starting the new release.

1. **Add Canary Variables to `/etc/AKA PAY/staging.env`:**
   ```bash
   # Add without displaying or printing existing secrets:
   sudo sed -i '/CANARY_/d' /etc/AKA PAY/staging.env
   echo "CANARY_MODE=true" | sudo tee -a /etc/AKA PAY/staging.env > /dev/null
   echo "CANARY_MERCHANT_ALLOWLIST=VVANFTTKRA" | sudo tee -a /etc/AKA PAY/staging.env > /dev/null
   echo "AKAPAY_VERIFICATION_POLICY=REQUIRE_DUAL_CHANNEL" | sudo tee -a /etc/AKA PAY/staging.env > /dev/null
   ```
2. **Validate Configuration Flags:**
   ```bash
   sudo grep -E 'CANARY_|VERIFICATION_POLICY' /etc/AKA PAY/staging.env
   ```
   *Expected output:*
   ```text
   CANARY_MODE=true
   CANARY_MERCHANT_ALLOWLIST=VVANFTTKRA
   AKAPAY_VERIFICATION_POLICY=REQUIRE_DUAL_CHANNEL
   ```

---

## 3. Atomic Deployment Procedure

1. **Upload Artifact to VM Staging Directory:**
   ```bash
   scp -i ~/.ssh/id_ed25519_oracle_staging reports/mitto-pay-rc1.tar.gz ubuntu@130.210.28.51:/tmp/mitto-pay-rc1.tar.gz
   scp -i ~/.ssh/id_ed25519_oracle_staging reports/mitto-pay-rc1.tar.gz.sha256 ubuntu@130.210.28.51:/tmp/mitto-pay-rc1.tar.gz.sha256
   ```

2. **Verify Checksum on VM:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "cd /tmp && sha256sum -c mitto-pay-rc1.tar.gz.sha256"
   ```
   *Must output:* `mitto-pay-rc1.tar.gz: OK`. If checksum fails, abort immediately.

3. **Create Pre-Canary Snapshot Backup:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "sudo cp -r /opt/aka-pay /opt/aka-pay-backup-pre-mitto-canary"
   ```

4. **Stop Service & Extract Release:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "
     sudo systemctl stop AKA PAY-staging.service
     sudo tar -xzf /tmp/mitto-pay-rc1.tar.gz -C /opt/aka-pay
     sudo chown -R ubuntu:ubuntu /opt/aka-pay
     echo 'mitto-pay-rc1-9fd6ed79' | sudo tee /opt/aka-pay/DEPLOYED_COMMIT > /dev/null
     sudo systemctl start AKA PAY-staging.service
   "
   ```

---

## 4. Post-Deployment Verification & Health Checks

1. **Service Readiness & Logs:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "
     systemctl is-active AKA PAY-staging.service
     sudo journalctl -u AKA PAY-staging.service -n 30 --no-pager
   "
   ```
2. **API Health Endpoint Check:**
   ```bash
   ssh -i ~/.ssh/id_ed25519_oracle_staging ubuntu@130.210.28.51 "curl -sSf http://127.0.0.1:6100/api/v1/health"
   ```
3. **Canary Isolation Synthetic Verification (Non-Production Traffic):**
   - Attempt creating payment for unauthorized merchant -> Expect `HTTP 403 CANARY_MERCHANT_UNAUTHORIZED`.
   - Attempt creating payment for `VVANFTTKRA` -> Expect `HTTP 201`.
   - Simulate single SMS alert -> Expect session status remains `PROCESSING` (Level 1).
   - Simulate secondary Gmail confirmation -> Expect session status advances to `SUCCESS` (Level 2).
4. **V-Visa Gateway Check:**
   - Confirm V-Visa order endpoint still defaults to Zoho Payments.
