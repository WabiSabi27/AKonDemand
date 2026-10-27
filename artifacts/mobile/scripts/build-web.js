/**
 * Production build script for the Expo web export.
 * Runs `expo export --platform web` and outputs to web-dist/.
 */
const { execSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const domain = process.env.REPLIT_INTERNAL_APP_DOMAIN || process.env.REPLIT_DEV_DOMAIN || 'localhost';

console.log('Building Expo web export...');
console.log(`Domain: ${domain}`);

try {
  execSync(
    'pnpm exec expo export --platform web --output-dir web-dist --clear',
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        EXPO_PUBLIC_DOMAIN: domain,
        EXPO_PUBLIC_REPL_ID: process.env.REPL_ID || '',
      },
    }
  );
  console.log('Web export complete → web-dist/');
} catch (err) {
  console.error('Web export failed:', err.message);
  process.exit(1);
}
