import { createAnalytics } from './analyticsClient.js';
export const { track, trackOnce, withUtm } = createAnalytics({ product: 'passage', prefix: 'dr', collector: 'https://oscar.deepregatta.com/api/event' });
