const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const origin = 'http://download.example.test';
const deepLink = 'exps://download.example.test';
const qrLibrary = 'https://unpkg.com/qr-code-styling@1.6.0/lib/qr-code-styling.js';
const template = fs.readFileSync(
  path.join(__dirname, '../../server/templates/landing-page.html'), 'utf8',
);
const navigationStatement = 'window.location.href = deepLink;';
// Location.href cannot be replaced in a browser. Change ONLY this navigation
// statement in the served fixture; all markup, CSS, detection and timers remain
// production code. Fail loudly if the template changes this seam.
expect(template.split(navigationStatement)).toHaveLength(2);
const html = template
  .replaceAll('APP_NAME_PLACEHOLDER', 'ServiceHub')
  .replaceAll('EXPS_URL_PLACEHOLDER', 'download.example.test')
  .replace(navigationStatement, 'window.__openingAttempts.push(deepLink);');

// Render a real 400px canvas like the library, exercising the template's CSS
// scaling. This is deliberately NOT a scannable QR code or a live CDN download.
const qrStub = `
  window.QRCodeStyling = class {
    constructor(options) { window.__qrData = options.data; this.options = options; }
    append(target) {
      const canvas = document.createElement('canvas');
      canvas.width = this.options.width;
      canvas.height = this.options.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#333';
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) {
          if ((x + y) % 3) ctx.fillRect(x * 20, y * 20, 18, 18);
        }
      }
      target.appendChild(canvas);
    }
  };
`;

const layouts = [
  {
    name: 'narrow iPhone', width: 320, height: 568, mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148',
    preferred: '#app-store-btn', secondary: '#play-store-btn',
  },
  {
    name: 'Android phone', width: 375, height: 667, mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0 Mobile Safari/537.36',
    preferred: '#play-store-btn', secondary: '#app-store-btn',
  },
  { name: 'desktop breakpoint', width: 768, height: 900, mobile: false },
  { name: 'wide desktop', width: 1440, height: 900, mobile: false },
];
const links = [
  ['#app-store-btn', 'https://apps.apple.com/app/id982107779'],
  ['#play-store-btn', 'https://play.google.com/store/apps/details?id=host.exp.exponent'],
  ['.open-button', deepLink],
];

async function expectReachable(page, selector, { interactive = false } = {}) {
  const element = page.locator(selector);
  await expect(element).toBeVisible();
  await element.scrollIntoViewIfNeeded();
  await expect(element).toBeInViewport({ ratio: 1 });
  const geometry = await element.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const card = el.closest('.step').getBoundingClientRect();
    return {
      x: rect.x, right: rect.right, width: rect.width, height: rect.height,
      cardLeft: card.left, cardRight: card.right,
      overflowing: el.scrollWidth > el.clientWidth + 1,
    };
  });
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(page.viewportSize().width);
  expect(geometry.x).toBeGreaterThanOrEqual(geometry.cardLeft);
  expect(geometry.right).toBeLessThanOrEqual(geometry.cardRight);
  expect(geometry.overflowing).toBe(false);
  if (interactive) {
    expect(geometry.width).toBeGreaterThanOrEqual(24);
    expect(geometry.height).toBeGreaterThanOrEqual(24);
    // Checks hit testing, stability, and absence of overlapping elements.
    await element.click({ trial: true });
  }
}

for (const layout of layouts) {
  for (const colorScheme of ['light', 'dark']) {
    for (const qr of ['available', 'unavailable']) {
      test(`${layout.name}, ${colorScheme}, QR ${qr}`, async ({ page, context }, testInfo) => {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.emulateMedia({ colorScheme });
        const unexpected = [];
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        // Fail closed BEFORE loading the fixture. No server, API, store, CDN,
        // payment endpoint, or external protocol handler is ever required.
        await context.route('**/*', route => {
          const request = route.request();
          if (request.method() === 'GET' && request.url() === `${origin}/`) {
            return route.fulfill({ contentType: 'text/html', body: html });
          }
          if (request.method() === 'GET' && request.url() === qrLibrary) {
            return route.fulfill({
              contentType: 'application/javascript',
              body: qr === 'available' ? qrStub : '/* QR library failed to load */',
            });
          }
          unexpected.push(`${request.method()} ${request.url()}`);
          return route.abort();
        });
        await context.addInitScript(({ userAgent }) => {
          if (userAgent) {
            Object.defineProperty(navigator, 'userAgent', { get: () => userAgent });
          }
          window.__openingAttempts = [];
          window.__linkActivations = [];
          document.addEventListener('click', event => {
            const link = event.target.closest('a');
            if (!link) return;
            event.preventDefault();
            window.__linkActivations.push(link.href);
          }, true);
        }, { userAgent: layout.userAgent });
        await page.clock.install();
        await page.goto(`${origin}/`);
        if (layout.mobile) {
          await expect(page.locator('#loading')).toBeVisible();
          await expect(page.locator('#content')).toBeHidden();
          await page.clock.runFor(500);
        }
        await expect(page.locator('#loading')).toBeHidden();
        await expect(page.locator('#content')).toBeVisible();
        expect(await page.evaluate(() => window.__openingAttempts))
          .toEqual(layout.mobile ? [deepLink] : []);

        // Assert the selected color mode is really rendered, not just configured.
        await expect(page.locator('body')).toHaveCSS('background-color',
          colorScheme === 'dark' ? 'rgb(13, 13, 13)' : 'rgb(255, 255, 255)');
        await expect(page.locator('.open-button')).toHaveCSS('background-color',
          colorScheme === 'dark' ? 'rgb(240, 240, 240)' : 'rgb(255, 255, 255)');
        if (layout.mobile) {
          await expect(page.locator('#store-buttons > a').first()).toHaveAttribute(
            'id', layout.preferred.slice(1),
          );
          await expect(page.locator(layout.preferred)).toHaveClass('store-button');
          await expect(page.locator(layout.secondary)).toHaveClass('store-link');
        }
        const cards = await page.locator('.step').evaluateAll(elements =>
          elements.map(el => {
            const { x, y, bottom } = el.getBoundingClientRect();
            return { x, y, bottom };
          }),
        );
        if (layout.mobile) {
          expect(cards[1].y).toBeGreaterThan(cards[0].bottom);
          expect(cards[1].x).toBe(cards[0].x);
        } else {
          expect(cards[1].x).toBeGreaterThan(cards[0].x);
          expect(cards[1].y).toBe(cards[0].y);
        }
        for (const [selector, href] of links) {
          await expect(page.locator(selector)).toHaveAttribute('href', href);
          await expectReachable(page, selector, { interactive: true });
        }
        await expectReachable(page, '#qr-code');
        if (qr === 'available') {
          await expectReachable(page, '#qr-code canvas');
          expect(await page.evaluate(() => window.__qrData)).toBe(deepLink);
        } else {
          await expect(page.locator('#qr-code')).toHaveAttribute('role', 'status');
          await expect(page.locator('#qr-code')).toHaveText(
            'QR code unavailable. Use Open in Expo Go on your phone.',
          );
        }
        expect(await page.evaluate(() => ({
          document: document.documentElement.scrollWidth > innerWidth,
          body: document.body.scrollWidth > innerWidth,
        }))).toEqual({ document: false, body: false });
        await page.screenshot({ path: testInfo.outputPath('download-instructions.png'), fullPage: true });

        // Verify real pointer and keyboard activation without leaving the page.
        for (const [selector] of links) await page.locator(selector).click();
        const tabOrder = await page.locator('a').evaluateAll(elements => elements.map(el => el.href));
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        for (const href of tabOrder) {
          await page.keyboard.press('Tab');
          await expect(page.locator(':focus')).toHaveAttribute('href', href);
          await page.keyboard.press('Enter');
        }
        expect(await page.evaluate(() => window.__linkActivations))
          .toEqual([...links.map(([, href]) => href), ...tabOrder]);
        expect(page.url()).toBe(`${origin}/`);
        expect(context.pages()).toHaveLength(1);
        expect(unexpected).toEqual([]);
        expect(pageErrors).toEqual([]);
      });
    }
  }
}
