import './akapay.js';
export * from './client.js';

export const AkaPayCheckout = (typeof window !== 'undefined' ? window.AkaPayCheckout : globalThis.AkaPayCheckout);
export const AkaPay = AkaPayCheckout;
