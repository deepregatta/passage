// The departure comparison off the page's main thread. See scanRunner.js.
import { createScanHandler } from './scanWorkerHandler.js';

const handle = createScanHandler((message) => self.postMessage(message));
self.addEventListener('message', (event) => { handle(event.data); });
self.postMessage({ type: 'ready' });
