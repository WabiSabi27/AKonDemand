const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { deflateSync } = require("node:zlib");

// Follow this app's Expo dependency graph. Multiple Metro versions can be
// installed in the workspace; a pinned pnpm path could test the wrong one.
const mobileRequire = createRequire(path.resolve(__dirname, "../package.json"));
const expoRequire = createRequire(mobileRequire.resolve("expo/metro-config"));
const configEntry = expoRequire.resolve("@expo/metro-config");
const configRequire = createRequire(configEntry);
const { transform } = require(path.join(
  path.dirname(configEntry), "transform-worker/asset-transformer.js",
));
const generate = configRequire("@babel/generator").default;
const minify = configRequire("@expo/metro/metro-minify-terser");
const { getDefaultConfig } = configRequire("@expo/metro/metro-config");

const timestamp = "1792756800000-compatibility";
const baseUrl = "https://native.example.test";
const platforms = ["ios", "android"];
const registryPath = "@react-native/assets-registry/registry";

// Small valid RGBA PNGs with different pixels and true density dimensions.
// Include real chunk checksums rather than making files distinct with junk.
function png(size, rgba) {
  function chunk(type, bytes) {
    const content = Buffer.concat([Buffer.from(type, "ascii"), bytes]);
    let crc = -1;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    const result = Buffer.alloc(content.length + 8);
    result.writeUInt32BE(bytes.length, 0);
    content.copy(result, 4);
    result.writeUInt32BE((crc ^ -1) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, ...Array(size).fill(rgba).flat()]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Evaluate only transformer-generated registration modules, never app bundles.
// This observes their semantics without depending on property spelling/order.
function readRegistrations(source) {
  const registrations = [];
  vm.runInNewContext(source, {
    module: { exports: {} },
    require(id) {
      assert.equal(id, registryPath);
      return { registerAsset(asset) { registrations.push(asset); return registrations.length; } };
    },
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(registrations));
}

const scenarios = [
  { label: "plain", imageDir: "assets/images with spaces/100%", fontDir: "assets/fonts",
    imageName: "badge", fontName: "Body" },
  { label: "Unicode and quotes", imageDir: 'assets/café "images"/100%', fontDir: "assets/字 'fonts'",
    imageName: '雪 "badge"', fontName: "Bódy 'font'" },
  // POSIX permits literal backslashes; Windows treats them as path separators.
  ...(process.platform === "win32" ? [] : [
    { label: "literal backslash directories", imageDir: 'assets/café\\images "quoted"/100%',
      fontDir: "assets/字\\fonts", imageName: '雪 "badge"', fontName: "Bódy 'font'" },
  ]),
];

for (const { basePath, label, imageDir, fontDir, imageName, fontName } of scenarios.flatMap(scenario =>
  ["/", "/mobile/"].map(basePath => ({ ...scenario, basePath })))) {
  test(`installed Expo/Metro ${label} assets survive extraction, byte-for-byte copying and rewriting at ${basePath}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "expo-metro-compatibility-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // Fail immediately if importing the build script accidentally starts work.
    // Unlike the serving tests, this compatibility test must not open services.
    const noService = () => { throw new Error("compatibility test must remain offline"); };
    const spawn = t.mock.method(require("node:child_process"), "spawn", noService);
    const fetch = t.mock.method(globalThis, "fetch", noService);
    const listen = t.mock.method(require("node:net").Server.prototype, "listen", noService);
    const { extractAssets, downloadAssets, updateBundleUrls, updateManifests } = require("../scripts/build.js");
    const { checkNativeBuild } = require("../scripts/check-native-build.cjs");
    const options = { projectRoot: root, workspaceRoot: root, basePath };
    const { transformer } = await getDefaultConfig(root);

    function write(relative, bytes) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      return target;
    }
    const bundlePath = (platform) =>
      `static-build/${timestamp}/_expo/static/js/${platform}/bundle.js`;

    // Metro reads dimensions and discovers each platform's density family.
    // Spaces and percent signs detect double decoding.
    const expectedCopies = new Map();
    for (const platform of platforms) {
      for (const scale of [1, 2]) {
        const stem = `${imageName}${scale === 1 ? "" : `@${scale}x`}`;
        const bytes = png(scale, [
          platform === "ios" ? 255 : 0, platform === "android" ? 255 : 0, scale * 50, 255,
        ]);
        write(`${imageDir}/${stem}.${platform}.png`, bytes);
        expectedCopies.set(`${platform}/${imageDir}/${stem}.png`, bytes);
      }
    }
    // A readable but different generic family must not override platform bytes.
    for (const scale of [1, 2]) {
      write(`${imageDir}/${imageName}${scale === 1 ? "" : `@${scale}x`}.png`,
        png(scale, [0, 0, scale * 50, 255]));
    }
    // Metro treats fonts as opaque bytes; no font parser or app dependency
    // needs to be loaded to generate their real registration source.
    const fontBytes = Buffer.from([0, 1, 0, 0, 255, 0, 128, 0]);
    write(`${fontDir}/${fontName}.ttf`, fontBytes);
    for (const platform of platforms) {
      expectedCopies.set(`${platform}/${fontDir}/${fontName}.ttf`, fontBytes);
    }

    const expectedByPlatform = new Map();
    for (const platform of platforms) {
      const sources = [];
      for (const filename of [`${imageDir}/${imageName}.png`, `${fontDir}/${fontName}.ttf`]) {
        const { ast } = await transform({
          filename,
          options: {
            projectRoot: root,
            platform,
            publicPath: "/assets/?unstable_path=.",
          },
        }, registryPath, []);
        sources.push(generate(ast).code);
      }
      const source = sources.join("\n");
      const registrations = readRegistrations(source);
      assert.equal(registrations.length, 2);
      assert.deepEqual(registrations.map(({ name, type, scales }) => ({ name, type, scales })), [
        { name: imageName, type: "png", scales: [1, 2] },
        { name: fontName, type: "ttf", scales: [1] },
      ]);
      assert.equal(registrations[0].width, 1);
      assert.equal(registrations[0].height, 1);
      for (const [index, asset] of registrations.entries()) {
        assert.equal(asset.__packager_asset, true);
        assert.match(asset.hash, /^[a-f0-9]{32}$/);
        assert.equal(new URL(asset.httpServerLocation, baseUrl).searchParams.get("unstable_path"),
          `./${index === 0 ? imageDir : fontDir}`);
      }
      // Minify without normalizing keys or reconstructing registration objects:
      // dependency changes in serialization/quoting/order must reach build.js.
      const { code } = await minify({
        code: source, filename: `${platform}-assets.js`,
        reserved: [], config: transformer.minifierConfig,
      });
      assert.deepEqual(readRegistrations(code), registrations);
      write(bundlePath(platform), code);
      expectedByPlatform.set(platform, registrations);
    }
    assert.notEqual(expectedByPlatform.get("ios")[0].hash, expectedByPlatform.get("android")[0].hash,
      "Different platform image bytes must reach the actual transformer");
    assert.equal(expectedByPlatform.get("ios")[1].hash, expectedByPlatform.get("android")[1].hash,
      "The same font still needs its own copy under each platform");

    const extracted = extractAssets(timestamp, options);
    assert.equal(extracted.length, 4, "both image and font must be found for each platform");
    for (const platform of platforms) {
      const actual = extracted.filter((asset) => asset.platforms.has(platform));
      assert.equal(actual.length, 2);
      for (const [index, expected] of expectedByPlatform.get(platform).entries()) {
        const asset = actual.find(({ name, type }) => name === expected.name && type === expected.type);
        assert.ok(asset, `missing ${platform}/${expected.name}.${expected.type}`);
        assert.equal(asset.originalPath, expected.httpServerLocation);
        assert.equal(asset.hash, expected.hash);
        assert.deepEqual(asset.scales, expected.scales);
        assert.equal(asset.filename, `${expected.name}.${expected.type}`);
        const directory = index === 0 ? imageDir : fontDir;
        assert.equal(asset.sourcePath, `./${directory}`);
        assert.equal(asset.relativePath, `${platform}/${directory}`);
        assert.deepEqual([...asset.platforms], [platform]);
      }
    }

    assert.equal(expectedCopies.size, 6);
    assert.equal(await downloadAssets(extracted, timestamp, options), expectedCopies.size);
    const outputRoot = path.join(root, "static-build", timestamp, "_expo/static/js");
    for (const [logicalFilename, bytes] of expectedCopies) {
      assert.deepEqual(fs.readFileSync(path.join(outputRoot, logicalFilename)), bytes,
        `${logicalFilename} must preserve the selected source's entire byte sequence`);
    }
    for (const platform of platforms) {
      assert.deepEqual(fs.readdirSync(path.join(outputRoot, platform, imageDir)).sort(),
        [`${imageName}.png`, `${imageName}@2x.png`].sort(), "Native image names must omit source platform suffixes");
      assert.deepEqual(fs.readdirSync(path.join(outputRoot, platform, fontDir)),
        [`${fontName}.ttf`], "Only the registered logical font must be copied");
    }

    updateBundleUrls(timestamp, baseUrl, options);
    for (const platform of platforms) {
      const rewritten = fs.readFileSync(path.join(root, bundlePath(platform)), "utf8");
      assert.ok(!rewritten.includes("unstable_path"), "no local asset URL may survive");
      const expected = expectedByPlatform.get(platform).map((asset, index) => ({
        ...asset,
        httpServerLocation: `${baseUrl}${basePath.replace(/\/+$/, "")}/${timestamp}/_expo/static/js/${platform}/${(index === 0 ? imageDir : fontDir).split("/").map(encodeURIComponent).join("/")}`,
      }));
      assert.deepEqual(readRegistrations(rewritten), expected,
        "rewriting changes only the location, preserving all generated metadata");
      for (const asset of readRegistrations(rewritten)) {
        const url = new URL(asset.httpServerLocation);
        assert.equal(url.search, "");
        assert.equal(url.hash, "");
        const directory = asset.type === "png" ? imageDir : fontDir;
        assert.equal(decodeURIComponent(url.pathname),
          `${basePath.replace(/\/+$/, "")}/${timestamp}/_expo/static/js/${platform}/${directory}`,
          "One URL decode must recover the original directory, including literal backslashes and percent signs");
      }
    }

    const manifests = Object.fromEntries(platforms.map(platform => [platform, {
      launchAsset: {}, assets: expectedByPlatform.get(platform).map(asset => ({
        hash: asset.hash, url: asset.httpServerLocation,
      })),
      extra: { expoClient: {}, expoGo: { packagerOpts: {} } },
    }]));
    const byHash = new Map(extracted.map(asset => [
      `${[...asset.platforms][0]}:${asset.hash}`, asset,
    ]));
    for (const platform of platforms) {
      fs.mkdirSync(path.join(root, "static-build", platform), { recursive: true });
    }
    updateManifests(manifests, timestamp, baseUrl, byHash, options);
    assert.deepEqual(checkNativeBuild({
      staticRoot: path.join(root, "static-build"), baseUrl, basePath,
    }), { checkedFiles: 12 });

    // Exercise the real static request handler directly, never listen on a port.
    // The server, template, sources, manifests and output all live in this root.
    for (const file of ["serve.js", "legacy-payment-return.js", "templates/landing-page.html"]) {
      write(`server/${file}`, fs.readFileSync(path.join(__dirname, file)));
    }
    const serverEntry = path.join(root, "server/serve.js");
    const previousBasePath = process.env.BASE_PATH;
    let server;
    try {
      process.env.BASE_PATH = basePath;
      server = require(serverEntry);
    } finally {
      if (previousBasePath === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = previousBasePath;
    }
    t.after(() => {
      delete require.cache[serverEntry];
      delete require.cache[path.join(root, "server/legacy-payment-return.js")];
    });
    function request(url) {
      const response = {};
      server.emit("request", { url, method: "GET", headers: { host: "native.example.test" } }, {
        writeHead(status) { response.status = status; },
        end(body) { response.body = body; },
      });
      return response;
    }
    for (const platform of platforms) {
      const rewritten = readRegistrations(fs.readFileSync(path.join(root, bundlePath(platform)), "utf8"));
      for (const asset of rewritten) {
        for (const scale of asset.scales) {
          const filename = `${asset.name}${scale === 1 ? "" : `@${scale}x`}.${asset.type}`;
          const directory = asset.type === "png" ? imageDir : fontDir;
          const url = new URL(`${asset.httpServerLocation}/${encodeURIComponent(filename)}`);
          const response = request(url.pathname);
          assert.equal(response.status, 200, url.href);
          assert.deepEqual(response.body, expectedCopies.get(`${platform}/${directory}/${filename}`),
            "The static handler must decode once and return the exact selected file");
        }
      }
    }
    assert.equal(request(`${basePath}%E0%A4%A`).status, 400, "Reject malformed escapes without crashing");
    assert.equal(request(`${basePath}%00`).status, 400, "Reject decoded NUL bytes");
    assert.equal(request(`${basePath}%2e%2e%2foutside`).status, 403,
      "Decoding must not allow escape from the temporary static root");
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(listen.mock.callCount(), 0);
  });
}
