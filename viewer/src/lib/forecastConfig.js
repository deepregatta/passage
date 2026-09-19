// Public deployment default, shared by tile and prepared-artifact readers.
// Local development keeps using the warehouse served by Vite's middleware.
export const FORECAST_BASE_URL = (import.meta.env.VITE_FORECAST_BASE_URL ||
  (import.meta.env.DEV ? '/data/forecast' : 'https://forecast.deepregatta.com')).replace(/\/+$/, '');
