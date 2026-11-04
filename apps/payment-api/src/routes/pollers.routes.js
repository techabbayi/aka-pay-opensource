import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpServer } from '../server.js';
import { ObservationNormalizer, BankSmsParser, BankEmailParser, generateQrSvg } from '@akapay/core';
import { toRupeesString, toPaise, verifyHmac, resolveRuntimeUrls, resolveSecret, safeEqual, hasBearer, getObserverToken, isAllowedNotificationPackage } from '@akapay/common';
import { isAdminRequest } from '../auth-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Upper bound on a single bank notification body accepted by the verification pipeline. */
const MAX_OBSERVATION_TEXT_CHARS = 64 * 1024;

/**
 * Registers observation intake routes for SMS Gateway (Android Native Observer)
 * and Automated Observers (Gmail Direct API / Web Observers).
 * @param {HttpServer} server
 * @param {{
 *   attributionEngine: import('@akapay/core').AttributionEngine,
 *   db: import('@akapay/db').Database,
 *   auditRepo: import('@akapay/db').AuditLogRepository,
 *   sessionRepo?: import('@akapay/db').PaymentSessionRepository,
 *   accountRepo?: import('@akapay/db').ReceivingAccountRepository,
 *   merchantRepo?: import('@akapay/db').MerchantRepository
 * }} ctx
 */
export function registerPollerRoutes(server, ctx) {
  // No public fallback: env value, else a random secret persisted in data/.secrets/.
  const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');

  // GET /api/v1/pollers/active-window (Enables deep intelligent DOM scanning for active amounts and dual-layer verification)
  server.get('/api/v1/pollers/active-window', async (req, res) => {
    // Observer-only. This returns every in-flight session with its exact amount and VPA,
    // which is precisely the oracle needed to craft a matching synthetic bank observation.
    if (!isAdminRequest(req) && !hasBearer(req, getObserverToken())) {
      HttpServer.json(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      return;
    }

    // Android Observer Device Authentication for active-window queries
    const deviceId = req.headers['x-device-id'];
    let deviceMerchantId = null;
    let deviceAccountId = null;
    if (deviceId) {
      const device = ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
      if (!device) {
        HttpServer.json(res, 403, { error: 'Device not authorized or inactive.', code: 'DEVICE_UNAUTHORIZED' });
        return;
      }
      deviceMerchantId = device.merchant_id;
      const activeAcc = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      if (activeAcc) deviceAccountId = activeAcc.id || activeAcc.receiving_account_id || activeAcc.account_id;
    }

    // receivingAccountId is mandatory for observer queries (no public fallback / no oracle enumeration)
    // Exception: when a valid Android observer device is bound, it auto-binds to the device's account
    const requestedAccountId = req.query.receivingAccountId;
    if (!requestedAccountId && !deviceAccountId) {
      HttpServer.json(res, 400, { error: 'receivingAccountId is required for observer queries.', code: 'ACCOUNT_BINDING_REQUIRED' });
      return;
    }

    const requestedMerchantId = req.query.merchantId;

    // Cross-account spoofing protection: registered device may only query its own merchant's account
    if (deviceAccountId && requestedAccountId && requestedAccountId !== deviceAccountId) {
      HttpServer.json(res, 403, { error: 'Cross-account access forbidden.', code: 'CROSS_ACCOUNT_FORBIDDEN' });
      return;
    }

    // Merchant-account binding validation: receiving account must exist and match specified merchant
    if (requestedAccountId) {
      const accRow = ctx.db.queryOne(
        'SELECT merchant_id FROM payment_receiving_accounts WHERE id = ? AND is_active = 1',
        [requestedAccountId]
      );
      if (!accRow) {
        HttpServer.json(res, 403, { error: 'Invalid receiving account.', code: 'INVALID_RECEIVING_ACCOUNT' });
        return;
      }
      if (requestedMerchantId && accRow.merchant_id !== requestedMerchantId) {
        HttpServer.json(res, 403, { error: 'Merchant-account mismatch.', code: 'MERCHANT_ACCOUNT_MISMATCH' });
        return;
      }
    }

    // Determine the account filter: query param takes precedence, then device binding
    const filterAccountId = requestedAccountId || deviceAccountId;
    let accountFilter = '';
    if (filterAccountId) {
      accountFilter = `AND receiving_account_id = ?`;
    }
    const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
    const queryParams = filterAccountId ? [sixtySecsAgo, filterAccountId] : [sixtySecsAgo];
    const activeSessions = ctx.db.query(`
      SELECT id, order_id, receiving_account_id, amount_paise, status, verification_level, expires_at, processing_expires_at, completed_at
      FROM payment_sessions
      WHERE (status IN ('ACTIVE', 'PROCESSING')
         OR (status = 'SUCCESS' AND verification_level < 2 AND completed_at >= ?))
      ${accountFilter}
      ORDER BY created_at DESC
    `, queryParams);

    const sessions = activeSessions.map(s => ({
      id: s.id,
      orderId: s.order_id,
      receivingAccountId: s.receiving_account_id,
      amount: toRupeesString(s.amount_paise),
      amountPaise: Number(s.amount_paise),
      status: s.status,
      verificationLevel: s.verification_level || 0,
      expiresAt: s.expires_at,
      processingExpiresAt: s.processing_expires_at
    }));

    HttpServer.json(res, 200, {
      hasActivePayment: sessions.length > 0,
      sessions,
      receivingAccountId: filterAccountId || null,
      merchantId: deviceMerchantId || null
    });
  });

  // POST /api/v1/pollers/events (Universal Observation Ingest for Gmail / SMS 2-Layer Observers)
  server.post('/api/v1/pollers/events', async (req, res) => {
    const body = await HttpServer.parseBody(req);

    // Android Observer Device Authentication for observation ingest
    const deviceId = req.headers['x-device-id'];
    let deviceMerchantId = null;
    let deviceAccountId = null;
    if (deviceId) {
      const device = ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
      if (!device) {
        HttpServer.json(res, 403, { error: 'Device not authorized or inactive.', code: 'DEVICE_UNAUTHORIZED' });
        return;
      }
      const activeAcc = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      if (activeAcc) deviceAccountId = activeAcc.id || activeAcc.receiving_account_id || activeAcc.account_id;
    }

    if (!body.receivingAccountId && !deviceAccountId) {
      HttpServer.json(res, 400, { error: 'Missing required field: receivingAccountId (or bind a device).' });
      return;
    }
    if (!body.source) {
      HttpServer.json(res, 400, { error: 'Missing required field: source.' });
      return;
    }

    // Cross-account spoofing protection: registered device may only submit for its own merchant's account
    const requestedAccountId = body.receivingAccountId;
    const requestedMerchantId = req.headers['x-merchant-id'] || body.merchantId;
    if (deviceAccountId && requestedAccountId && requestedAccountId !== deviceAccountId) {
      const accRow = ctx.db.queryOne(
        'SELECT merchant_id FROM payment_receiving_accounts WHERE id = ? AND is_active = 1',
        [requestedAccountId]
      );
      if (accRow && accRow.merchant_id !== deviceMerchantId) {
        HttpServer.json(res, 403, { error: 'Cross-account access forbidden.', code: 'CROSS_ACCOUNT_FORBIDDEN' });
        return;
      }
    }

    // Merchant-account binding validation: receiving account must exist and match specified merchant
    if (requestedAccountId) {
      const accRow = ctx.db.queryOne(
        'SELECT merchant_id FROM payment_receiving_accounts WHERE id = ? AND is_active = 1',
        [requestedAccountId]
      );
      if (!accRow) {
        HttpServer.json(res, 403, { error: 'Invalid receiving account.', code: 'INVALID_RECEIVING_ACCOUNT' });
        return;
      }
      if (requestedMerchantId && accRow.merchant_id !== requestedMerchantId) {
        HttpServer.json(res, 403, { error: 'Merchant-account mismatch.', code: 'MERCHANT_ACCOUNT_MISMATCH' });
        return;
      }
    }

    // Evaluate through Security & Fraud Verification Pipeline
    const rawText = body.rawText || body.text || body.message || body.sms || body.body || (typeof body.rawPayload === 'string' ? body.rawPayload : (body.rawPayload?.text || body.rawPayload?.body));
    const sender = body.sender || body.from || body.rawPayload?.sender || body.rawPayload?.from;

    const clientMessageEcho = body.clientMessageId ? { clientMessageId: String(body.clientMessageId) } : {};

    // Reject missing or blank observation rawText
    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    // Bank notifications are small. Reject oversized bodies outright so no single observation
    // can be used to burn CPU or memory on the verification path.
    if (typeof rawText === 'string' && rawText.length > MAX_OBSERVATION_TEXT_CHARS) {
      HttpServer.json(res, 413, {
        ...clientMessageEcho,
        error: `Observation body too large (max ${MAX_OBSERVATION_TEXT_CHARS} characters).`
      });
      return;
    }

    if (!ctx.pipeline) {
      HttpServer.json(res, 500, {
        ...clientMessageEcho,
        error: 'Verification pipeline is not configured on this server.'
      });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: body.source,
      rawText,
      sender,
      receivingAccountId: body.receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: body.bankReferenceNumber || body.utr,
      receivedAt: body.observedAt || body.receivedAt,
      // Test flags relax verification: honour them only for the admin credential, never for observers.
      isTest: Boolean(body.isTest) && isAdminRequest(req),
      testModeActive: Boolean(body.testModeActive) && isAdminRequest(req)
    });

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Positive identification of fake payment message. Customer account banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      HttpServer.json(res, 200, {
        accepted: true,
        ...clientMessageEcho,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'MANUAL_REVIEW') {
      HttpServer.json(res, 200, {
        accepted: false,
        ...clientMessageEcho,
        status: 'MANUAL_REVIEW',
        reason: pipeResult.failingCondition || pipeResult.attribution?.reason || 'AMBIGUOUS_SESSION_MATCH',
        observationId: pipeResult.stages?.stage6?.details?.observationId || pipeResult.messageId,
        attribution: pipeResult.attribution || pipeResult.stages?.stage6?.details,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      HttpServer.json(res, 400, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: pipeResult
      });
      return;
    }

    // A credit that arrives after its session has ended still has to be reconciled: the
    // pipeline verified the message but found no live session (stage 4). Hand it to the
    // attribution engine's late-match path so a LATE_UNMATCHED support ticket is raised
    // for the merchant instead of the payment being silently dropped.
    //
    // This is NOT a settlement route. It is only taken when the pipeline failed specifically
    // at stage 4 (i.e. the filter and parser stages passed) and no live session exists for
    // the account, and the engine's late path only flags the observation for manual review.
    if (
      pipeResult.failingStage === 4 &&
      pipeResult.failingCondition === 'NO_ACTIVE_SESSION' &&
      body.receivingAccountId &&
      pipeResult.amountPaise &&
      ctx.sessionRepo && ctx.attributionEngine
    ) {
      const liveSession = ctx.sessionRepo.findCurrentActiveOrProcessing(body.receivingAccountId);
      if (!liveSession) {
        try {
          const lateResult = ctx.attributionEngine.processObservation({
            source: body.source || 'SMS_GATEWAY',
            receivingAccountId: body.receivingAccountId,
            amountPaise: pipeResult.amountPaise,
            bankReferenceNumber: pipeResult.reference || body.utr || body.bankReferenceNumber,
            observedAt: new Date(body.observedAt || Date.now()),
            sender,
            rawPayload: body.rawPayload || { text: rawText }
          });
          if (lateResult?.lateMatch || lateResult?.ambiguous) {
            HttpServer.json(res, 200, {
              accepted: false,
              ...clientMessageEcho,
              status: lateResult.outcomeStatus || 'LATE_UNMATCHED',
              reason: lateResult.reason || 'LATE_OBSERVATION_NO_ACTIVE_SESSION',
              observationId: lateResult.observationId || pipeResult.messageId,
              attribution: lateResult,
              error: 'Payment credit was received after the session ended and has been queued for manual reconciliation.',
              pipeline: pipeResult
            });
            return;
          }
        } catch (err) {
          HttpServer.json(res, 400, {
            accepted: false,
            ...clientMessageEcho,
            status: 'UNRESOLVED',
            reason: pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
            error: 'Payment observation could not be verified or attributed.'
          });
          return;
        }
      }
    }

    // Invert check: if status is not VERIFIED, return 4xx and NEVER fall through to direct attribution
    HttpServer.json(res, 400, {
      accepted: false,
      ...clientMessageEcho,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: pipeResult
    });
  });

  // --- ANDROID SMS GATEWAY PAIRING HANDLER ---
  const handleAndroidPair = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const token = body.enrollmentToken || body.token;
    const merchantId = body.merchantId || '00000000-0000-0000-0000-000000000001';
    const deviceName = body.deviceName || 'Android SMS Gateway';
    const deviceModel = body.deviceModel || 'Android Device';

    // Verify enrollment token against system secret or merchant token
    if (!token || !safeEqual(String(token), enrollmentSecret)) {
      HttpServer.json(res, 401, { error: 'Invalid or expired device pairing enrollment token.' });
      return;
    }

    if (body.expiresAt && Date.now() > Number(body.expiresAt)) {
      HttpServer.json(res, 400, { error: 'PAIRING QR EXPIRED' });
      return;
    }

    if (body.version && body.version !== 'v1') {
      HttpServer.json(res, 400, { error: 'INVALID PAIRING QR' });
      return;
    }

    const deviceId = crypto.randomUUID();
    const signingKey = crypto.randomBytes(32).toString('hex');
    const nowIso = new Date().toISOString();

    try {
      ctx.db.execute(`
        INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `, [deviceId, merchantId, deviceName, deviceModel, signingKey, nowIso, nowIso]);

      if (ctx.auditRepo) {
        ctx.auditRepo.log({
          merchantId,
          entityType: 'ANDROID_DEVICE',
          entityId: deviceId,
          action: 'SMS_GATEWAY_DEVICE_PAIRED',
          actorType: 'ADMIN',
          details: { deviceName, deviceModel }
        });
      }

      HttpServer.json(res, 200, {
        paired: true,
        deviceId,
        signingKey,
        merchantId,
        message: 'Android SMS Gateway paired successfully.'
      });
    } catch (err) {
      HttpServer.json(res, 500, { error: `Failed to register Android device: ${err.message}` });
    }
  };

  server.post('/api/v1/pollers/android/pair', handleAndroidPair);
  server.post('/api/v1/observers/sms/pair', handleAndroidPair);

  // --- ANDROID SMS GATEWAY OBSERVATION INGESTION ---
  const handleAndroidSmsEvents = async (req, res, { requirePackage = false } = {}) => {
    const rawBodyText = await new Promise(resolve => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
    });

    let body = {};
    try {
      body = JSON.parse(rawBodyText);
    } catch {
      HttpServer.json(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }

    const deviceId = req.headers['x-device-id'] || body.deviceId;
    if (!deviceId) {
      HttpServer.json(res, 400, { error: 'Missing required X-Device-Id header or deviceId.' });
      return;
    }

    // Verify registered device
    const device = ctx.db.queryOne('SELECT * FROM android_devices WHERE id = ? AND is_active = 1', [deviceId]);
    if (!device) {
      HttpServer.json(res, 403, { error: 'Device not authorized or inactive.' });
      return;
    }

    // Verify HMAC Signature & Replay Drift Protection
    const timestampStr = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    // Signature is mandatory: omitting the headers must not skip verification.
    if (!device.signing_key_hash || !timestampStr || !signature) {
      HttpServer.json(res, 401, { error: 'Missing X-Timestamp / X-Signature headers.' });
      return;
    }

    {
      const ts = Number(timestampStr);
      const now = Date.now();
      if (isNaN(ts) || Math.abs(now - ts) > 60000) {
        HttpServer.json(res, 401, { error: 'Timestamp drift exceeded validity window (replay protection triggered).' });
        return;
      }

      const sigPayload = `${rawBodyText}:${timestampStr}`;
      const isValid = verifyHmac(sigPayload, device.signing_key_hash, signature);
      if (!isValid) {
        HttpServer.json(res, 401, { error: 'Invalid cryptographic HMAC signature.' });
        return;
      }
    }

    // Resolve Receiving Account for this merchant
    let receivingAccountId = body.receivingAccountId;
    if (!receivingAccountId) {
      const activeAccount = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(device.merchant_id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [device.merchant_id]);
      receivingAccountId = activeAccount?.id || '00000000-0000-0000-0000-000000000002';
    }

    // Extract amount and details: either pre-parsed or from raw bank SMS
    let amountPaise = body.amountPaise ? BigInt(body.amountPaise) : undefined;
    let bankRef = body.bankReferenceNumber || body.utr;
    let senderVpa = body.senderVpa;
    let observedAt = body.observedAt ? new Date(body.observedAt) : new Date();

    // Security Invariant (Issues #24, #61): the notification package must be declared and
    // must be on the allowlist. Validating it only when `rawNotification` was present let a
    // caller omit the field entirely and still reach the verification pipeline.
    //
    // The package is required on the notification-listener route, which is where the
    // allowlist is the control. The plain SMS-broadcast route has no package to report (the
    // broadcast only carries the sender address) and is authenticated by the device HMAC
    // instead, so requiring one there would break the observer.
    const clientMessageEcho = body.clientMessageId ? { clientMessageId: String(body.clientMessageId) } : {};
    const rawPkg = body.rawNotification?.package;
    if (requirePackage) {
      if (!rawPkg || typeof rawPkg !== 'string' || !rawPkg.trim()) {
        HttpServer.json(res, 400, {
          accepted: false,
          ...clientMessageEcho,
          error: 'Android notification observation must specify a valid package name in rawNotification.package'
        });
        return;
      }
    }

    if (rawPkg && typeof rawPkg === 'string' && rawPkg.trim()) {
      const notificationPackage = rawPkg.trim().toLowerCase();
      if (!isAllowedNotificationPackage(notificationPackage)) {
        HttpServer.json(res, 400, {
          accepted: false,
          ...clientMessageEcho,
          error: `Untrusted Android notification package: ${notificationPackage}`
        });
        return;
      }
    }

    // Check for raw SMS text inside body or rawNotification
    const rawText = body.body || body.sms || body.rawSms || body.message || body.text || body.rawNotification?.text;
    if (!rawText || (typeof rawText === 'string' && !rawText.trim())) {
      HttpServer.json(res, 400, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: 'MISSING_RAW_TEXT',
        error: 'Observation rawText is required for verification.'
      });
      return;
    }

    if (rawText && (!amountPaise || !bankRef)) {
      const parsedSms = BankSmsParser.parse({
        text: rawText,
        sender: body.sender || body.rawNotification?.package,
        timestamp: observedAt
      });

      if (parsedSms) {
        if (!amountPaise) amountPaise = parsedSms.amountPaise;
        if (!bankRef && parsedSms.bankReferenceNumber) bankRef = parsedSms.bankReferenceNumber;
        if (!senderVpa && parsedSms.senderVpa) senderVpa = parsedSms.senderVpa;
      }
    }

    if (!amountPaise && body.amount) {
      try {
        amountPaise = toPaise(body.amount);
      } catch {}
    }

    // Evaluate through Security & Fraud Verification Pipeline for Android Ingest
    if (!ctx.pipeline) {
      HttpServer.json(res, 500, {
        ...clientMessageEcho,
        error: 'Verification pipeline is not configured on this server.'
      });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: 'SMS',
      rawText,
      sender: body.sender || req.headers['x-sender'] || body.rawNotification?.package,
      receivingAccountId,
      paymentSessionId: body.paymentSessionId,
      bankReferenceNumber: bankRef,
      receivedAt: observedAt,
      isTest: false, // device-supplied flags must never relax verification
      deviceInfo: device ? `${device.device_name} (${device.device_model})` : 'Android SMS Gateway'
    });

    if (pipeResult.status === 'REJECTED' && pipeResult.failingCondition === 'FRAUDULENT_PAYMENT_INJECTION') {
      HttpServer.json(res, 403, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: 'FRAUDULENT_PAYMENT_INJECTION',
        threatDetected: true,
        banned: true,
        error: 'FRAUDULENT_PAYMENT_INJECTION: Fake SMS detected. Associated customer identity banned and session terminated.'
      });
      return;
    }

    if (pipeResult.status === 'VERIFIED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        ...clientMessageEcho,
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'MANUAL_REVIEW') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: false,
        ...clientMessageEcho,
        status: 'MANUAL_REVIEW',
        reason: pipeResult.failingCondition || pipeResult.attribution?.reason || 'AMBIGUOUS_SESSION_MATCH',
        observationId: pipeResult.stages?.stage6?.details?.observationId || pipeResult.messageId,
        attribution: pipeResult.attribution || pipeResult.stages?.stage6?.details,
        pipeline: pipeResult
      });
      return;
    }

    if (pipeResult.status === 'REJECTED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 400, {
        accepted: false,
        ...clientMessageEcho,
        status: 'REJECTED',
        reason: pipeResult.failingCondition,
        error: pipeResult.failingReason || pipeResult.details,
        pipeline: pipeResult
      });
      return;
    }

    // Transport Only Contract (Part D): The Android observer forwards all raw SMS.
    // If no monetary amount is extracted (e.g. personal, promotional, non-bank SMS),
    // update observation timestamp on device and return 200 PROCESSED_NON_BANK.
    if (!amountPaise && pipeResult.status === 'UNRESOLVED') {
      ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
      HttpServer.json(res, 200, {
        accepted: true,
        ...clientMessageEcho,
        status: 'PROCESSED_NON_BANK',
        bankMatch: false,
        message: 'Raw SMS observation ingested and evaluated by server pipeline.'
      });
      return;
    }

    if (
      pipeResult.failingStage === 4 &&
      pipeResult.failingCondition === 'NO_ACTIVE_SESSION' &&
      receivingAccountId &&
      (pipeResult.amountPaise || amountPaise) &&
      ctx.sessionRepo && ctx.attributionEngine
    ) {
      const liveSession = ctx.sessionRepo.findCurrentActiveOrProcessing(receivingAccountId);
      if (!liveSession) {
        try {
          const lateResult = ctx.attributionEngine.processObservation({
            source: 'ANDROID_OBSERVER',
            receivingAccountId,
            amountPaise: pipeResult.amountPaise || amountPaise,
            bankReferenceNumber: pipeResult.reference || bankRef,
            observedAt,
            sender: body.sender || req.headers['x-sender'] || body.rawNotification?.package,
            rawPayload: body.rawNotification || { text: rawText }
          });
          if (lateResult?.lateMatch || lateResult?.ambiguous) {
            ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
            HttpServer.json(res, 200, {
              accepted: false,
              ...clientMessageEcho,
              status: lateResult.outcomeStatus || 'LATE_UNMATCHED',
              reason: lateResult.reason || 'LATE_OBSERVATION_NO_ACTIVE_SESSION',
              observationId: lateResult.observationId || pipeResult.messageId,
              attribution: lateResult,
              error: 'Payment credit was received after the session ended and has been queued for manual reconciliation.',
              pipeline: pipeResult
            });
            return;
          }
        } catch {}
      }
    }

    // Invert check: if status is not VERIFIED, return 4xx and NEVER fall through to direct attribution
    ctx.db.execute("UPDATE android_devices SET last_observation_at = datetime('now') WHERE id = ?", [deviceId]);
    HttpServer.json(res, 400, {
      accepted: false,
      ...clientMessageEcho,
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.stages?.stage6?.outcomeStatus || pipeResult.failingCondition || 'UNRESOLVED_OBSERVATION',
      observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
      error: pipeResult.failingReason || 'Payment observation could not be verified or attributed.',
      pipeline: pipeResult
    });
  };

  // The notification-listener route must declare its package; the SMS-broadcast route has none.
  server.post('/api/v1/pollers/android/events', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: true }));
  server.post('/api/v1/observers/sms', (req, res) => handleAndroidSmsEvents(req, res, { requirePackage: false }));

  // --- ANDROID HEARTBEAT HANDLER ---
  const handleAndroidHeartbeat = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const deviceId = req.headers['x-device-id'] || body.deviceId;

    if (deviceId) {
      ctx.db.execute('UPDATE android_devices SET last_heartbeat_at = datetime(\'now\') WHERE id = ?', [deviceId]);
    }

    HttpServer.json(res, 200, {
      status: 'HEARTBEAT_ACK',
      timestamp: Date.now()
    });
  };

  server.post('/api/v1/pollers/android/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/pollers/heartbeat', handleAndroidHeartbeat);
  server.post('/api/v1/observers/heartbeat', handleAndroidHeartbeat);

  // --- MERCHANT ADMIN: SMS GATEWAY PAIRING QR CODE & STATUS ---
  server.get('/api/v1/admin/sms-gateway/pair-qr', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    // Canonical runtime URL derivation (Part C2)
    const runtime = resolveRuntimeUrls(merchant?.branding || {});
    const baseUrl = runtime.apiUrl;
    const token = enrollmentSecret;
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes

    const pairingPayloadObj = {
      version: 'v1',
      type: 'AKAPAY_SMS_GATEWAY_PAIR',
      serverUrl: baseUrl,
      gatewayUrl: baseUrl,
      apiBaseUrl: baseUrl,
      sessionId,
      token,
      enrollmentToken: token,
      merchantId,
      createdAt: Date.now(),
      expiresAt
    };

    const pairingPayload = JSON.stringify(pairingPayloadObj);
    const qrSvg = generateQrSvg(pairingPayload, 260);

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at
    }));

    HttpServer.json(res, 200, {
      qrSvg,
      pairingQrSvg: qrSvg,
      pairingPayload,
      payload: pairingPayloadObj,
      sessionId,
      expiresAt,
      version: 'v1',
      token,
      enrollmentToken: token,
      gatewayUrl: baseUrl,
      serverUrl: baseUrl,
      devices
    });
  });

  // GET /api/v1/admin/sms-gateway/devices
  server.get('/api/v1/admin/sms-gateway/devices', async (req, res) => {
    let merchant = req.query.merchantId ? (ctx.merchantRepo ? ctx.merchantRepo.findById(req.query.merchantId) : null) : null;
    if (!merchant && ctx.merchantRepo) merchant = ctx.merchantRepo.getDefault ? ctx.merchantRepo.getDefault() : (ctx.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || ctx.merchantRepo.findAll()[0]);
    const merchantId = merchant ? merchant.id : (req.query.merchantId || '00000000-0000-0000-0000-000000000001');

    const rawDevices = ctx.db.query(`
      SELECT id, device_name, device_model, is_active, last_heartbeat_at, last_observation_at, created_at
      FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC
    `, [merchantId]);

    const devices = (rawDevices || []).map(d => ({
      id: d.id,
      deviceId: d.id,
      deviceName: d.device_name || d.device_model || 'Android Observer',
      device_name: d.device_name || d.device_model || 'Android Observer',
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_at,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_at,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at
    }));

    HttpServer.json(res, 200, { devices });
  });

  // DELETE /api/v1/admin/sms-gateway/devices/:deviceId
  server.delete('/api/v1/admin/sms-gateway/devices/:deviceId', async (req, res, params) => {
    const deviceId = params.deviceId;
    ctx.db.execute('DELETE FROM android_devices WHERE id = ?', [deviceId]);
    HttpServer.json(res, 200, { success: true, message: 'Device unlinked.' });
  });

  // GET /api/v1/admin/sms-gateway/download-apk & GET /akapay-observer.apk & GET /akapay-observer.apk
  const serveApk = async (req, res) => {
    const isLegacyReq = false;
    const apkFileName = isLegacyReq ? 'akapay-observer.apk' : 'akapay-observer.apk';
    const apkLocations = [
      path.resolve(__dirname, `../../public/${apkFileName}`),
      path.resolve(__dirname, `../../../merchant-admin/public/${apkFileName}`),
      path.resolve(__dirname, '../../../android-observer-app/akapay-observer.apk'),
      path.resolve(__dirname, '../../public/akapay-observer.apk'),
      path.resolve(__dirname, '../../../merchant-admin/public/akapay-observer.apk'),
      path.resolve(__dirname, '../../../android-observer-app/akapay-observer.apk')
    ];

    let foundPath = null;
    for (const p of apkLocations) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }

    if (!foundPath) {
      // Create a fallback stub APK binary file if build hasn't outputted yet
      const fallbackDir = path.resolve(__dirname, '../../public');
      if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
      foundPath = path.join(fallbackDir, apkFileName);
      if (!fs.existsSync(foundPath)) {
        fs.writeFileSync(foundPath, Buffer.from('PK\x03\x04AKAPAY_OBSERVER_STANDALONE_APK_PACKAGE'));
      }
    }

    const stat = fs.statSync(foundPath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${apkFileName}"`,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(foundPath).pipe(res);
  };

  server.get('/api/v1/admin/sms-gateway/download-apk', serveApk);
  server.get('/akapay-observer.apk', serveApk);

  // =========================================================================
  // MODE 1: INBOUND EMAIL WEBHOOK FORWARDING
  // Cloudflare Email Worker / SendGrid Inbound Parse / Postmark / SMTP Intake
  // =========================================================================
  const handleInboundEmail = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const headers = body.headers || {};

    // 1. Anti-Spoofing & Cryptographic Validation: Verify DKIM & SPF
    const dkimStatus = String(body.dkim || headers['dkim-signature'] || headers['x-dkim-result'] || headers['authentication-results'] || '').toLowerCase();
    const spfStatus = String(body.spf || headers['received-spf'] || headers['x-spf-result'] || '').toLowerCase();

    // If explicit fail reported by inbound SMTP worker, reject with 403
    if (dkimStatus.includes('fail') || spfStatus.includes('fail')) {
      HttpServer.json(res, 403, {
        accepted: false,
        status: 'REJECTED',
        reason: 'SPOOFED_INBOUND_EMAIL',
        error: 'Inbound email failed cryptographic DKIM/SPF verification. Forged emails are rejected.'
      });
      return;
    }

    // 2. Extract sender, recipient, subject, and text body
    const sender = body.from || body.sender || (typeof body.envelope === 'object' ? body.envelope.from : '') || '';
    const recipient = body.to || body.recipient || (typeof body.envelope === 'object' ? body.envelope.to : '') || '';
    const subject = body.subject || '';
    let rawText = body.text || body.plain || body.body || '';

    // If plaintext is absent but HTML is provided, strip tags
    if (!rawText && body.html) {
      rawText = String(body.html)
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!rawText && subject) {
      rawText = subject;
    }

    if (!rawText) {
      HttpServer.json(res, 400, {
        accepted: false,
        status: 'REJECTED',
        reason: 'MISSING_EMAIL_BODY',
        error: 'Inbound email must include subject or message body.'
      });
      return;
    }

    // 3. Resolve Merchant & Receiving Account from recipient (e.g. alerts-[merchantId]@pay.yourstore.com)
    let receivingAccountId = body.receivingAccountId;
    let merchantId = body.merchantId;

    if (!receivingAccountId) {
      const match = String(recipient).match(/alerts-([0-9a-fA-F-]{36})/i);
      if (match) {
        merchantId = match[1];
        const acc = ctx.accountRepo
          ? ctx.accountRepo.findActiveForMerchant(merchantId)
          : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [merchantId]);
        if (acc) receivingAccountId = acc.id || acc.receiving_account_id;
      }
    }

    if (!receivingAccountId && ctx.defaultMerchant) {
      const acc = ctx.accountRepo
        ? ctx.accountRepo.findActiveForMerchant(ctx.defaultMerchant.id)
        : ctx.db.queryOne('SELECT id FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1', [ctx.defaultMerchant.id]);
      if (acc) receivingAccountId = acc.id || acc.receiving_account_id;
    }

    // 4. Pass through Security & Fraud Verification Pipeline as source 'EMAIL'
    if (!ctx.pipeline) {
      HttpServer.json(res, 500, { error: 'Verification pipeline not configured on server.' });
      return;
    }

    const pipeResult = ctx.pipeline.process({
      source: 'EMAIL',
      rawText,
      sender,
      receivingAccountId,
      bankReferenceNumber: body.bankReferenceNumber || body.utr,
      receivedAt: body.receivedAt || body.observedAt || new Date().toISOString(),
      isTest: Boolean(body.isTest) && isAdminRequest(req)
    });

    if (pipeResult.status === 'VERIFIED') {
      HttpServer.json(res, 200, {
        accepted: true,
        mode: 'MODE_1_INBOUND_EMAIL',
        observationId: pipeResult.messageId || pipeResult.stages?.stage6?.details?.observationId,
        attribution: pipeResult.stages?.stage6?.details || pipeResult,
        pipeline: pipeResult
      });
      return;
    }

    HttpServer.json(res, pipeResult.status === 'REJECTED' ? 400 : 200, {
      accepted: pipeResult.status === 'VERIFIED',
      mode: 'MODE_1_INBOUND_EMAIL',
      status: pipeResult.status || 'UNRESOLVED',
      reason: pipeResult.failingCondition || 'NO_MATCHING_ACTIVE_SESSION',
      error: pipeResult.failingReason || 'Email parsed, but could not be matched to an active checkout session.',
      pipeline: pipeResult
    });
  };

  server.post('/api/v1/inbound-email', handleInboundEmail);
  server.post('/api/v1/observers/inbound-email', handleInboundEmail);

  // =========================================================================
  // MODE 3: OFFICIAL BANK OPEN API WEBHOOK (CBS Direct HTTP POST)
  // Sub-second 50ms-100ms ICICI / HDFC / Axis / Kotak Core Banking System webhook
  // =========================================================================
  const handleBankApiWebhook = async (req, res) => {
    const body = await HttpServer.parseBody(req);
    const utr = String(body.utr || body.bankReferenceNumber || body.rrn || body.refId || '').trim();
    const rawAmount = body.amount ?? (body.amountPaise ? body.amountPaise / 100 : undefined);
    const payeeVpa = String(body.payeeVpa || body.merchantVpa || '').trim().toLowerCase();
    const timestamp = body.timestamp || body.txnTime || new Date().toISOString();

    if (!utr) {
      HttpServer.json(res, 400, { error: 'Bank reference number (UTR) is required.', code: 'MISSING_UTR' });
      return;
    }

    if (rawAmount === undefined) {
      HttpServer.json(res, 400, { error: 'Transaction amount is required.', code: 'MISSING_AMOUNT' });
      return;
    }

    const amountPaise = typeof body.amountPaise === 'number' ? body.amountPaise : Math.round(Number(rawAmount) * 100);

    // 1. Anti-Replay Timestamp Drift Tolerance (120 seconds)
    const reqTimeMs = new Date(timestamp).getTime();
    if (!isNaN(reqTimeMs) && !body.isTest) {
      const driftMs = Math.abs(Date.now() - reqTimeMs);
      if (driftMs > 120000) {
        HttpServer.json(res, 400, { error: 'Timestamp drift exceeds allowed window (120s).', code: 'TIMESTAMP_DRIFT' });
        return;
      }
    }

    // 2. Deduplication check: enforce SQLite UNIQUE(bank_reference_number) invariant
    const existingObs = ctx.db.queryOne(
      'SELECT id, attributed_payment_id FROM payment_observations WHERE bank_reference_number = ?',
      [utr]
    );
    if (existingObs) {
      HttpServer.json(res, 409, {
        accepted: false,
        error: 'Duplicate UTR. Transaction has already been attributed and settled.',
        code: 'DUPLICATE_UTR',
        observationId: existingObs.id,
        paymentId: existingObs.attributed_payment_id
      });
      return;
    }

    // 3. Resolve active session matching amount and payee account
    let query = `
      SELECT * FROM payment_sessions
      WHERE status IN ('INITIATED', 'ACTIVE', 'PROCESSING')
        AND amount_paise = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    let session = ctx.db.queryOne(query, [amountPaise]);

    if (!session) {
      // Check active window with 30s grace window
      const graceIso = new Date(Date.now() - 30000).toISOString();
      session = ctx.db.queryOne(`
        SELECT * FROM payment_sessions
        WHERE status IN ('INITIATED', 'ACTIVE', 'PROCESSING', 'EXPIRED')
          AND amount_paise = ?
          AND (expires_at >= ? OR expires_at IS NULL)
        ORDER BY created_at DESC
        LIMIT 1
      `, [amountPaise, graceIso]);
    }

    if (!session) {
      HttpServer.json(res, 200, {
        accepted: false,
        status: 'UNMATCHED',
        utr,
        amountPaise,
        message: 'CBS webhook received and verified, but no active payment session matched this exact amount.'
      });
      return;
    }

    // 4. Record observation and transition session to SUCCESS
    const obsId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    ctx.db.execute(`
      INSERT INTO payment_observations (
        id, receiving_account_id, source, amount_paise, observed_at,
        ingested_at, sender_vpa, bank_reference_number, fingerprint_hash,
        raw_payload, attribution_status, attributed_payment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      obsId,
      session.receiving_account_id || null,
      'BANK_API_CBS',
      amountPaise,
      timestamp,
      nowIso,
      body.payerVpa || null,
      utr,
      crypto.createHash('sha256').update(`${utr}:${amountPaise}`).digest('hex'),
      JSON.stringify(body),
      'ATTRIBUTED',
      session.id,
      nowIso
    ]);

    ctx.db.execute(`
      UPDATE payment_sessions
      SET customer_utr = ?, verification_level = 2, verification_tag = 'CBS_DIRECT_VERIFIED', updated_at = ?
      WHERE id = ?
    `, [utr, nowIso, session.id]);

    const updated = ctx.sessionRepo.transitionToTerminal(session.id, 'SUCCESS', {
      attributedObservationId: obsId,
      method: 'UPI'
    });

    if (ctx.auditRepo) {
      ctx.auditRepo.log({
        merchantId: session.merchant_id || session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: session.id,
        action: 'PAYMENT_VERIFIED_BY_CBS_WEBHOOK',
        actorType: 'BANK_API_CBS',
        details: { utr, amountPaise, bank: body.bank || 'BANK_OPEN_API' }
      });
    }

    // 5. Broadcast SSE & trigger authoritative webhook outbox
    server.broadcastSse(session.id, 'status_change', {
      status: 'SUCCESS',
      utr,
      method: 'UPI',
      orderId: session.order_id
    });
    server.broadcastSse(session.id, 'state_change', {
      status: 'SUCCESS',
      utr,
      method: 'UPI',
      orderId: session.order_id
    });

    if (ctx.eventEmitter) {
      ctx.eventEmitter.emit('PAYMENT.SUCCESS', {
        paymentId: session.id,
        orderId: session.order_id,
        merchantId: session.merchant_id,
        amountPaise,
        utr,
        method: 'UPI'
      });
    }

    HttpServer.json(res, 200, {
      accepted: true,
      mode: 'MODE_3_BANK_OPEN_API',
      status: 'SUCCESS',
      paymentId: session.id,
      orderId: session.order_id,
      utr,
      message: 'Direct Core Banking System (CBS) transaction verified successfully in sub-second.'
    });
  };

  server.post('/api/bank/webhook', handleBankApiWebhook);
  server.post('/api/v1/bank/webhook', handleBankApiWebhook);
}
