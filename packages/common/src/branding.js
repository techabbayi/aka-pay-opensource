/**
 * Centralized White-Label Branding Configuration
 *
 * Configures customer-facing brand identity across checkout-portal,
 * payment-api, and banking observers.
 */
export const BRANDING_CONFIG = Object.freeze({
  businessName: 'AKA PAY Merchant',
  poweredBy: 'AKA PAY',
  appName: 'AKA PAY',
  tagline: 'UPI & Payment Infrastructure, Also Known As. Always Connected.',
  supportEmail: 'support@akapay.dev',
  supportEmails: Object.freeze(['support@akapay.dev']),
  supportPhone: '+91 8610648309',
  supportMobiles: Object.freeze(['+91 8610648309']),
  logoUrl: '',
  primaryColor: '#2563eb',
  sidebarNotice: 'Fast & Secure 256-Bit Bank Encryption',
  trustBadgeText: 'Verified Business · Powered by AKA PAY',
  counterInstructions: 'Please visit the billing counter and present this screen to the cashier.',
  cardCounterInstructions: 'Please swipe, insert, or tap your credit or debit card on the store POS terminal at the billing desk.',
});
