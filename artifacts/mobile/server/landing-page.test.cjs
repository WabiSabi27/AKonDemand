const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const template = fs.readFileSync(path.join(__dirname, 'templates/landing-page.html'), 'utf8');
const destination = 'exps://download.example.test';
const devices = [
  {
    name: 'iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', maxTouchPoints: 5, store: 'ios',
  },
  {
    name: 'iPad with a mobile user agent',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    platform: 'iPad', maxTouchPoints: 5, store: 'ios',
  },
  {
    name: 'iPod',
    userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPod', maxTouchPoints: 5, store: 'ios',
  },
  {
    name: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', maxTouchPoints: 5, store: 'android',
  },
  {
    name: 'iPad with a desktop-style user agent',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 5, store: 'ios',
  },
  {
    name: 'Mac desktop without touch',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 0, store: null,
  },
  {
    name: 'Mac desktop at the single-touch detection boundary',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 1, store: null,
  },
  {
    name: 'Windows touchscreen desktop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    platform: 'Win32', maxTouchPoints: 10, store: null,
  },
];

const qrScenarios = ['working', 'missing', 'constructor throws', 'append throws'];

function runLandingPage(t, device, qrScenario) {
  // Parse the actual markup but never load the CDN script, images, or links.
  // Execute only its inline scripts in a VM with no network or real navigation.
  const dom = new JSDOM(template.replace(/EXPS_URL_PLACEHOLDER/g, 'download.example.test'));
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const loading = document.getElementById('loading');
  const content = document.getElementById('content');
  const navigations = [];
  const qrCodes = [];
  const scheduledDelays = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const location = {
    set href(value) {
      navigations.push({
        destination: value,
        loadingDisplay: dom.window.getComputedStyle(loading).display,
        contentDisplay: dom.window.getComputedStyle(content).display,
      });
    },
  };
  class QRCodeStyling {
    constructor(options) {
      if (qrScenario === 'constructor throws') {
        throw new Error('QR initialization failed');
      }
      this.options = options;
      this.targets = [];
      qrCodes.push(this);
    }
    append(target) {
      if (qrScenario === 'append throws') {
        throw new Error('QR rendering failed');
      }
      this.targets.push(target);
    }
  }
  const context = vm.createContext({
    document,
    navigator: {
      userAgent: device.userAgent,
      platform: device.platform,
      maxTouchPoints: device.maxTouchPoints,
    },
    window: { location },
    ...(qrScenario === 'missing' ? {} : { QRCodeStyling }),
    setTimeout(callback, delay) {
      scheduledDelays.push(delay);
      return setTimeout(callback, delay);
    },
  });
  const scripts = [...document.querySelectorAll('script:not([src])')];
  assert.ok(scripts.length > 0, 'The template must contain its inline behavior');
  for (const script of scripts) {
    vm.runInContext(script.textContent, context, { timeout: 1000, filename: 'landing-page.html' });
  }
  return {
    document, navigations, qrCodes, scheduledDelays,
    displays: () => ({
      loading: dom.window.getComputedStyle(loading).display,
      content: dom.window.getComputedStyle(content).display,
    }),
  };
}

for (const { device, qrScenario } of qrScenarios.flatMap((qrScenario) =>
  devices.map((device) => ({ device, qrScenario })))) {
  test(`download page: ${device.name}, QR library ${qrScenario}`, async (t) => {
    const page = runLandingPage(t, device, qrScenario);

    await t.test('puts the preferred store first and de-emphasizes only the other store', () => {
      const buttons = [...page.document.getElementById('store-buttons').children];
      assert.deepEqual(buttons.map((button) => button.id), device.store === 'android'
        ? ['play-store-btn', 'app-store-btn']
        : ['app-store-btn', 'play-store-btn']);
      assert.equal(page.document.getElementById('app-store-btn').className,
        device.store === 'android' ? 'store-link' : 'store-button');
      assert.equal(page.document.getElementById('play-store-btn').className,
        device.store === 'ios' ? 'store-link' : 'store-button');
    });

    await t.test('keeps Open in Expo Go available with or without a QR code', () => {
      const openLink = page.document.querySelector('a.open-button');
      assert.ok(openLink);
      assert.equal(openLink.textContent.trim(), 'Open in Expo Go');
      assert.equal(openLink.getAttribute('href'), destination);
      const qrContainer = page.document.getElementById('qr-code');
      if (qrScenario === 'working') {
        assert.equal(page.qrCodes.length, 1);
        const [qrCode] = page.qrCodes;
        assert.equal(qrCode.options.data, openLink.href);
        assert.deepEqual(qrCode.targets, [qrContainer]);
        assert.equal(qrContainer.textContent, '');
        assert.equal(qrContainer.hasAttribute('role'), false);
      } else {
        assert.equal(page.qrCodes.length, qrScenario === 'append throws' ? 1 : 0);
        assert.equal(qrContainer.textContent,
          'QR code unavailable. Use Open in Expo Go on your phone.');
        assert.equal(qrContainer.getAttribute('role'), 'status');
        assert.equal(qrContainer.style.color, 'rgb(51, 51, 51)');
      }
    });

    await t.test('opens only on mobile and restores content at exactly 500ms', () => {
      const mobile = device.store !== null;
      assert.deepEqual(page.navigations, mobile ? [{
        destination,
        loadingDisplay: 'block',
        contentDisplay: 'none',
      }] : []);
      assert.deepEqual(page.scheduledDelays, mobile ? [500] : []);
      const initialDisplays = mobile
        ? { loading: 'block', content: 'none' }
        : { loading: 'none', content: 'block' };
      assert.deepEqual(page.displays(), initialDisplays);
      t.mock.timers.tick(499);
      assert.deepEqual(page.displays(), initialDisplays, 'Do not reveal content before the fallback');
      t.mock.timers.tick(1);
      assert.deepEqual(page.displays(), { loading: 'none', content: 'block' });
      t.mock.timers.tick(1000);
      assert.deepEqual(page.displays(), { loading: 'none', content: 'block' });
      assert.equal(page.navigations.length, mobile ? 1 : 0, 'Do not retry automatic navigation');
      assert.deepEqual(page.scheduledDelays, mobile ? [500] : [], 'Do not schedule repeated fallbacks');
    });
  });
}
