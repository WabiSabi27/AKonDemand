/**
 * Static server for the Expo web export (web-dist/).
 * Serves the SPA with proper asset MIME types.
 * All unmatched routes fall back to index.html for client-side routing.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redirectLegacyPaymentReturn } = require('./legacy-payment-return');

const DIST_ROOT = path.resolve(__dirname, '..', 'web-dist');
const INDEX_HTML = path.join(DIST_ROOT, 'index.html');
const basePath = (process.env.BASE_PATH || '/').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.map':  'application/json',
  '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  if (redirectLegacyPaymentReturn(req, res)) return;
  let pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(DIST_ROOT, safePath);

  if (!filePath.startsWith(DIST_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = INDEX_HTML;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  const content = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': contentType,
    // A preview can receive a new export at the same URL after a restart.
    // Revalidate bundles as well as HTML instead of retaining stale API config.
    'cache-control': 'no-cache',
  });
  res.end(content);
});

if (require.main === module) {
  // The managed preview serves an export, not Metro's live source. Refresh it
  // on startup; production already builds this export before starting.
  if (process.env.NODE_ENV !== 'production') {
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/build-web.js')], {
      stdio: 'inherit',
    });
  }
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen(port, '0.0.0.0', () => {
    console.log(`Serving Expo web build on port ${port} (base: ${basePath || '/'})`);
  });
}

module.exports = server;
