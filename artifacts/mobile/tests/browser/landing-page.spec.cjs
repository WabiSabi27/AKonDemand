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
// Text-only enlargement keeps the CSS viewport unchanged. Cover both store
// preferences at the narrowest width, plus the two-column breakpoint.
const enlargedTextLayouts = [
  { ...layouts[0], name: 'narrow iPhone, 200% text', textScale: 2 },
  { ...layouts[1], name: 'narrow Android, 200% text', width: 320, textScale: 2 },
  { ...layouts[2], name: 'desktop breakpoint, 200% text', textScale: 2 },
];
const links = [
  ['#app-store-btn', 'https://apps.apple.com/app/id982107779'],
  ['#play-store-btn', 'https://play.google.com/store/apps/details?id=host.exp.exponent'],
  ['.open-button', deepLink],
];

test.beforeAll(async ({ browserName, playwright, launchOptions }) => {
  // Keep Chromium, explicit overrides, and strict CI runs mandatory.
  if (browserName === 'chromium' || launchOptions.executablePath ||
      process.env.LANDING_PAGE_REQUIRE_ALL_BROWSERS === '1') return;
  const browserType = playwright[browserName];
  test.skip(!fs.existsSync(browserType.executablePath()),
    `${browserName} runtime not installed; run pnpm --filter @workspace/mobile exec playwright install ${browserName}`,
  );

  // Probe without a page or network access. Only Playwright's specific missing
  // host-dependency diagnostic means unsupported here. Crashes, timeouts and
  // all test failures must remain failures, not become "unavailable" skips.
  let probe;
  try {
    probe = await browserType.launch(launchOptions);
  } catch (error) {
    if (!error.message.includes('Host system is missing dependencies to run browsers.')) throw error;
    test.skip(true,
      `${browserName} host libraries unavailable; on supported Linux run playwright install --with-deps ${browserName}`,
    );
  } finally {
    if (probe) await probe.close();
  }
});

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
      overflowingVertically: el.scrollHeight > el.clientHeight + 1,
      // Scroll dimensions alone miss text painted outside a flex item or
      // clipped with overflow:hidden. Check the rendered text itself too.
      textContained: (() => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const text of range.getClientRects()) {
            if (text.left < rect.left - 1 || text.right > rect.right + 1 ||
                text.top < rect.top - 1 || text.bottom > rect.bottom + 1) return false;
          }
        }
        return true;
      })(),
    };
  });
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(page.viewportSize().width);
  expect(geometry.x).toBeGreaterThanOrEqual(geometry.cardLeft);
  expect(geometry.right).toBeLessThanOrEqual(geometry.cardRight);
  expect(geometry.overflowing).toBe(false);
  expect(geometry.overflowingVertically).toBe(false);
  expect(geometry.textContained).toBe(true);
  if (interactive) {
    expect(geometry.width).toBeGreaterThanOrEqual(24);
    expect(geometry.height).toBeGreaterThanOrEqual(24);
    // Checks hit testing, stability, and absence of overlapping elements.
    await element.click({ trial: true });
  }
}

for (const layout of [...layouts, ...enlargedTextLayouts]) {
  for (const colorScheme of ['light', 'dark']) {
    for (const qr of ['available', 'unavailable']) {
      test(`${layout.name}, ${colorScheme}, QR ${qr}`, async ({ page, context, browserName }, testInfo) => {
        // UA overrides below exercise OS detection only. The project must still
        // launch its own real engine; do not replace Firefox/WebKit with Chromium
        // device descriptors (Firefox also does not support isMobile emulation).
        expect(context.browser().browserType().name()).toBe(browserName);
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
            // SVG clicks can have a non-HTMLElement target in different engines.
            const link = event.target instanceof Element && event.target.closest('a');
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
        if (layout.textScale) {
          // Do not use CSS zoom, a transform, or only html font-size (the
          // template uses px). Snapshot every computed size before writing,
          // so inherited text is enlarged exactly once and layout is untouched.
          const sizes = await page.locator('body').evaluate((body, scale) => {
            const elements = [body, ...body.querySelectorAll('*')];
            const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
            elements.forEach((el, index) => {
              el.style.fontSize = `${sizes[index] * scale}px`;
            });
            return elements.filter(el => el.matches('#qr-code, a'))
              .map(el => sizes[elements.indexOf(el)]);
          }, layout.textScale);
          // Store buttons transition "all"; wait for computed text sizes to
          // settle rather than measuring an intermediate animation frame.
          expect(sizes).toHaveLength(4);
          await expect.poll(() => page.locator('#qr-code, a').evaluateAll(elements =>
            elements.map(el => parseFloat(getComputedStyle(el).fontSize)),
          )).toEqual(sizes.map(size => size * layout.textScale));
        }
        await expect(page.getByRole('heading', { name: 'Download Expo Go' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Scan QR Code' })).toBeVisible();
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
          const separated = await page.locator('#qr-code').evaluate(el =>
            el.getBoundingClientRect().bottom <=
              document.querySelector('.open-button').getBoundingClientRect().top,
          );
          expect(separated).toBe(true);
        }
        expect(await page.evaluate(() => ({
          document: document.documentElement.scrollWidth > innerWidth,
          body: document.body.scrollWidth > innerWidth,
        }))).toEqual({ document: false, body: false });
        await page.screenshot({ path: testInfo.outputPath('download-instructions.png'), fullPage: true });

        // Verify real pointer and keyboard activation without leaving the page.
        for (const [selector] of links) await page.locator(selector).click();
        const tabOrder = await page.locator('a').evaluateAll(elements => elements.map(el => el.href));
        // Start at a known focus position: clicking the body does not reset the
        // sequential keyboard focus starting point consistently across engines.
        await page.locator('a').first().focus();
        for (const [index, href] of tabOrder.entries()) {
          if (index > 0) await page.keyboard.press('Tab');
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
