// Data middleware pattern vendored from coachregatta viewer2/vite.config.js (2026-07-11),
// adapted for deepweather: snapshots manifest instead of race index, .png artifacts allowed,
// and dev-only POST endpoints so the in-browser engine can persist routes and snapshots.
// The Pages build packages demo data as static assets, reads forecast tiles
// from R2, and saves user snapshots in browser-local IndexedDB.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const SNAPSHOTS_MANIFEST_PATH = '/data/snapshots/manifest.json';

function buildSnapshotsManifest(dataRoot) {
  const snapshotsRoot = path.join(dataRoot, 'snapshots');
  const snapshots = [];

  if (fs.existsSync(snapshotsRoot)) {
    const entries = fs
      .readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first (ids start with departure date)

    for (const entry of entries) {
      const manifestPath = path.join(snapshotsRoot, entry.name, 'snapshot.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        snapshots.push({
          snapshot_id: manifest.snapshot_id ?? entry.name,
          created_at: manifest.created_at,
          route_id: manifest.route_id,
          profile_id: manifest.profile_id,
          departure_utc: manifest.departure_utc,
          verdict_state: manifest.verdict_state ?? null,
          demo: manifest.demo ?? false,
        });
      } catch (error) {
        console.warn(`[data-middleware] Skipping invalid ${manifestPath}: ${error.message}`);
      }
    }
  }

  return { generated_at: new Date().toISOString(), snapshots };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeResolve(root, relativePath) {
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) return null;
  return filePath;
}

function dataMiddleware() {
  const dataRoot = process.env.VITE_DW_FIXTURE === 'demo'
    ? path.resolve(__dirname, './test/fixtures/demo')
    : path.resolve(__dirname, '../data/processed');

  return {
    name: 'data-middleware',
    configureServer(server) {
      const handleRequest = async (req, res, next) => {
        const requestPath = req.url?.split('?')[0] || '';
        if (!requestPath.startsWith('/data/')) return next();

        // Validate escapes before any branch can decode or use the request path.
        decodeURIComponent(requestPath);

        // ---- dev-only persistence for the in-browser engine ----
        if (req.method === 'POST') {
          const writable = [
            { prefix: '/data/routes/', root: path.join(dataRoot, 'routes') },
            { prefix: '/data/snapshots/', root: path.join(dataRoot, 'snapshots') },
          ].find((w) => requestPath.startsWith(w.prefix));

          if (!writable) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }

          const relative = decodeURIComponent(requestPath.slice(writable.prefix.length));
          const filePath = safeResolve(writable.root, relative);
          if (!filePath || !filePath.endsWith('.json')) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
          }

          // snapshots are immutable: never overwrite an existing artifact
          if (requestPath.startsWith('/data/snapshots/') && fs.existsSync(filePath)) {
            res.statusCode = 409;
            res.end('Snapshot artifacts are write-once');
            return;
          }

          try {
            const body = await readBody(req);
            JSON.parse(body); // must be valid JSON
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, body);
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            res.statusCode = 400;
            res.end(`Bad request: ${error.message}`);
          }
          return;
        }

        // ---- dev-only deletion: a briefing is the user's to discard ----
        if (req.method === 'DELETE') {
          if (process.env.VITE_DW_FIXTURE) {
            res.statusCode = 403;
            res.end('Fixture data is read-only');
            return;
          }
          const match = requestPath.match(/^\/data\/snapshots\/([^/]+)$/);
          const dirPath = match && safeResolve(path.join(dataRoot, 'snapshots'), decodeURIComponent(match[1]));
          if (!dirPath || !fs.existsSync(path.join(dirPath, 'snapshot.json'))) {
            res.statusCode = 404;
            res.end('No such snapshot');
            return;
          }
          fs.rmSync(dirPath, { recursive: true, force: true });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ---- reads ----
        if (requestPath === SNAPSHOTS_MANIFEST_PATH) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(buildSnapshotsManifest(dataRoot)));
          return;
        }

        if (requestPath === '/data/runs/latest.json' && !fs.existsSync(path.join(dataRoot, 'runs', 'latest.json'))) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ run_id: null, artifacts: {} }));
          return;
        }

        if (requestPath === '/data/routes/index.json') {
          const routesDir = path.join(dataRoot, 'routes');
          const routes = fs.existsSync(routesDir)
            ? fs
                .readdirSync(routesDir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => {
                  try {
                    const r = JSON.parse(fs.readFileSync(path.join(routesDir, f), 'utf8'));
                    return { route_id: r.route_id, name: r.name, mode: r.mode, file: f };
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean)
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ routes }));
          return;
        }

        if (requestPath === '/data/verification/cases/index.json') {
          const casesDir = path.join(dataRoot, 'verification', 'cases');
          const existing = path.join(casesDir, 'index.json');
          const cases = fs.existsSync(existing)
            ? JSON.parse(fs.readFileSync(existing, 'utf8')).cases ?? []
            : fs.existsSync(casesDir)
              ? fs.readdirSync(casesDir).filter((file) => file.endsWith('.json') && file !== 'index.json').map((file) => {
                  try {
                    const doc = JSON.parse(fs.readFileSync(path.join(casesDir, file), 'utf8'));
                    return { snapshot_id: doc.snapshot_id ?? file.slice(0, -5), observation_source: doc.observation_source ?? 'unknown' };
                  } catch { return null; }
                }).filter(Boolean)
              : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ cases }));
          return;
        }

        // read-only view of repo config (providers, profiles, routes) for the UI
        const configRoot = path.resolve(__dirname, '../config');
        const relativePath = decodeURIComponent(requestPath.slice(6));
        const filePath = relativePath.startsWith('config/')
          ? safeResolve(configRoot, relativePath.slice('config/'.length))
          : safeResolve(dataRoot, relativePath);
        if (!filePath) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        // forecast tiles: a local fixture run under data/processed/forecast/
        // (e.g. from `ingest weather --dry-run`) mirrors the R2 layout
        if (requestPath.startsWith('/data/forecast/') && requestPath.endsWith('.bin.gz')) {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(fs.readFileSync(filePath));
            return;
          }
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const contentTypes = {
          '.json': 'application/json',
          '.geojson': 'application/geo+json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
        };
        const ext = path.extname(filePath).toLowerCase();
        if (!contentTypes[ext]) {
          // Vite's public/ directory owns these committed deployment assets
          // (including .bin.gz, which the allowlist above would otherwise 403).
          if (requestPath.startsWith('/data/polars/') || requestPath.startsWith('/data/land/')) {
            return next();
          }
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader('Content-Type', contentTypes[ext]);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(fs.readFileSync(filePath));
          return;
        }

        // Vite's public/ directory owns these committed deployment assets
        // (tides fall through too: the synthetic constituents are committed
        // for production and only overridden by a local pipeline run).
        if (
          requestPath.startsWith('/data/polars/') ||
          requestPath.startsWith('/data/land/') ||
          requestPath.startsWith('/data/tides/')
        ) {
          return next();
        }

        res.statusCode = 404;
        res.end('Not found');
      };
      server.middlewares.use((req, res, next) => handleRequest(req, res, next).catch((error) => {
        res.statusCode = error instanceof URIError || error instanceof SyntaxError ? 400 : 500;
        res.end(res.statusCode === 400 ? 'Bad request' : 'Internal server error');
      }));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), dataMiddleware()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    sourcemap: mode !== 'production',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/echarts') || id.includes('/node_modules/zrender') || id.includes('/node_modules/echarts-for-react')) return 'vendor-echarts';
          if (id.includes('/node_modules/leaflet') || id.includes('/node_modules/react-leaflet')) return 'vendor-leaflet';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'vendor-react';
        },
      },
    },
  },
}));
