import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutServer } from '../server.js';
import { BRANDING_CONFIG } from '../config/branding.js';

describe('White-Label Branding & Checkout Identity Tests', () => {
  const server = new CheckoutServer();

  test('renderHtml defaults to AKA PAY branding when state is minimal/demo', () => {
    const html = server.renderHtml('test-payment-123', {
      orderId: 'ORD-999',
      amount: '500.00'
    });

    // 1. Page title must feature AKA PAY Checkout
    assert.ok(html.includes('<title>Merchant Checkout · AKA PAY Checkout</title>'), 'Title must have AKA PAY Checkout');

    // 2. Trust badge must state "AKA PAY Verified Business"
    assert.ok(html.includes('AKA PAY Verified Business'), 'Trust badge must be AKA PAY Verified Business');

    // 3. App Name and brand identity
    assert.ok(html.includes('AKA PAY'), 'Rendered HTML must contain AKA PAY');

    // 4. Splash screen and footer powered by text
    assert.ok(html.includes('Secured by AKA PAY &amp; 256-Bit Bank Encryption') || html.includes('Secured by AKA PAY'), 'Footer must say Secured by AKA PAY');

    // 5. Verification wording
    assert.ok(html.includes('Verifying Your Payment'), 'Processing modal must state Verifying Your Payment');
  });

  test('renderHtml preserves custom merchant branding when merchant supplies their own brand', () => {
    const html = server.renderHtml('custom-payment-456', {
      merchantName: 'Acme Corp',
      branding: {
        appName: 'Acme Gateway',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#ff0000',
        supportEmails: ['help@acme.com'],
        supportMobiles: ['+91 9999999999']
      }
    });

    assert.ok(html.includes('<title>Acme Corp · Acme Gateway Checkout</title>'));
    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes('https://example.com/logo.png'));
    assert.ok(html.includes('help@acme.com'));
  });
});
