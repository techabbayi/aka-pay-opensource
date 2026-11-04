import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@akapay/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus, PaymentMethod } from '@akapay/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

describe('Multi-Observer Ingest Modes (Mode 1 Inbound Email, Mode 3 Bank API CBS, Mode 5 Counter POS)', () => {
  let apiInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    process.env.NODE_ENV = 'test';
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6196, testDb);
    baseUrl = `http://localhost:${apiInstance.port}`;
  });

  after(async () => {
    await apiInstance.close();
    testDb.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...authHeadersFor(path),
          ...(path.startsWith('/api/v1/payments') ? { 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' } : {}),
          ...(options.headers || {})
        }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode, body });
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('Mode 1: Inbound Email Webhook rejects spoofed emails when DKIM fails', async () => {
    const res = await request('/api/v1/inbound-email', {
      method: 'POST',
      body: {
        from: 'fake@hdfcbank.net',
        to: 'alerts-00000000-0000-0000-0000-000000000001@pay.yourstore.com',
        subject: 'Credit alert',
        text: 'Your a/c is credited INR 500.00 Ref 123456789012',
        dkim: 'fail'
      }
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'SPOOFED_INBOUND_EMAIL');
  });

  test('Mode 1: Inbound Email Webhook accepts verified bank credit alert', async () => {
    // 1. Create a payment session
    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-EMAIL-001',
        amount: 350,
        currency: 'INR'
      }
    });
    assert.equal(createRes.status, 201);
    const sessionId = createRes.body.paymentId;

    // 2. Fire verified inbound email webhook
    const emailRes = await request('/api/v1/inbound-email', {
      method: 'POST',
      body: {
        from: 'alerts@hdfcbank.net',
        to: 'alerts-00000000-0000-0000-0000-000000000001@pay.yourstore.com',
        subject: 'Credit Alert: Rs 350.00 credited',
        text: 'Your A/C ending 4321 is credited with INR 350.00 on 04-Nov-26 by UPI/987654321098/REF...',
        headers: {
          'dkim-signature': 'v=1; a=rsa-sha256; d=hdfcbank.net; pass',
          'received-spf': 'pass'
        },
        dkim: 'pass',
        spf: 'pass',
        bankReferenceNumber: '987654321098'
      }
    });

    assert.equal(emailRes.status, 200);
    assert.equal(emailRes.body.mode, 'MODE_1_INBOUND_EMAIL');
  });

  test('Mode 3: Official Bank Open API CBS Webhook verifies sub-second transaction and prevents duplicate UTR', async () => {
    // 1. Create a payment session
    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-CBS-001',
        amount: 799,
        currency: 'INR'
      }
    });
    assert.equal(createRes.status, 201);
    const sessionId = createRes.body.paymentId;

    // 2. CBS fires direct HTTP POST
    const cbsRes = await request('/api/bank/webhook', {
      method: 'POST',
      body: {
        event: 'CREDIT',
        bank: 'ICICI',
        utr: '778899001122',
        amount: '799.00',
        amountPaise: 79900,
        payeeVpa: 'store@okhdfcbank',
        payerVpa: 'customer@oksbi',
        timestamp: new Date().toISOString()
      }
    });

    assert.equal(cbsRes.status, 200);
    assert.equal(cbsRes.body.mode, 'MODE_3_BANK_OPEN_API');
    assert.equal(cbsRes.body.status, 'SUCCESS');
    assert.equal(cbsRes.body.utr, '778899001122');
    assert.equal(cbsRes.body.paymentId, sessionId);

    // 3. Duplicate UTR replay attack is rejected with 409
    const dupRes = await request('/api/bank/webhook', {
      method: 'POST',
      body: {
        event: 'CREDIT',
        bank: 'ICICI',
        utr: '778899001122',
        amount: '799.00',
        timestamp: new Date().toISOString()
      }
    });

    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.body.code, 'DUPLICATE_UTR');
  });

  test('Mode 5: Counter POS aliases (/api/v1/counter/approve and decline) approve and decline physical payments', async () => {
    // 1. Create cash counter payment
    const createRes = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-POS-001',
        amount: 250,
        currency: 'INR',
        method: PaymentMethod.CASH_COUNTER
      }
    });
    assert.equal(createRes.status, 201);
    const sessionId = createRes.body.paymentId;

    // 2. Approve via /api/v1/counter/approve
    const approveRes = await request('/api/v1/counter/approve', {
      method: 'POST',
      body: {
        paymentId: sessionId,
        operatorId: 'CASHIER-REGISTER-1',
        method: PaymentMethod.CASH_COUNTER
      }
    });

    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.confirmed, true);
    assert.equal(approveRes.body.status, PaymentStatus.SUCCESS);

    // 3. Create second counter payment and decline it
    const createRes2 = await request('/api/v1/payments', {
      method: 'POST',
      body: {
        orderId: 'ORDER-POS-002',
        amount: 500,
        currency: 'INR',
        method: PaymentMethod.CARD_COUNTER
      }
    });
    assert.equal(createRes2.status, 201);
    const sessionId2 = createRes2.body.paymentId;

    const declineRes = await request('/api/v1/counter/decline', {
      method: 'POST',
      body: {
        paymentId: sessionId2,
        operatorId: 'CASHIER-REGISTER-1',
        reason: 'Customer cancelled transaction at till'
      }
    });

    assert.equal(declineRes.status, 200);
    assert.equal(declineRes.body.declined, true);
    assert.equal(declineRes.body.status, PaymentStatus.FAILED);
  });
});

