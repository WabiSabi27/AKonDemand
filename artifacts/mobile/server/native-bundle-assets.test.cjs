const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const {
  extractAssets, downloadAssets, updateBundleUrls, updateManifests,
} = require("../scripts/build.js");
const { checkNativeBuild } = require("../scripts/check-native-build.cjs");

const timestamp = "1792756800000-123";
const baseUrl = "https://native.example.test";
const platforms = ["ios", "android"];

// Metro's minified asset transformer emits this shape. No asset needs to
// appear in a manifest for React Native to request all its registered scales.
function registration(directory, name, type, scales = [1], hash = name) {
  const location = `/assets/?unstable_path=${encodeURIComponent(directory)}&platform=fixture`;
  return `__d(function(g,r,i,a,m,e,d){m.exports=r(d[0]).registerAsset({__packager_asset:!0,httpServerLocation:${JSON.stringify(location)},width:24,height:24,scales:${JSON.stringify(scales)},hash:${JSON.stringify(hash)},name:${JSON.stringify(name)},type:${JSON.stringify(type)}})},42,[1]);`;
}

function fixture(t, basePath = "/") {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "expo-bundle-assets-"));
  const projectRoot = path.join(workspaceRoot, "artifacts/mobile");
  const options = { projectRoot, workspaceRoot, basePath };
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  function write(target, contents) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
  }
  const bundlePath = (platform) =>
    path.join(projectRoot, "static-build", timestamp, "_expo/static/js", platform, "bundle.js");
  const bundle = (platform, contents) => write(bundlePath(platform), contents);
  for (const platform of platforms) {
    bundle(platform, "// fixture bundle\n");
    fs.mkdirSync(path.join(projectRoot, "static-build", platform), { recursive: true });
  }
  return {
    ...options, options, write, bundle, bundlePath,
    source: (relative, bytes, workspace = false) =>
      write(path.join(workspace ? workspaceRoot : projectRoot, relative), bytes),
    extract: () => extractAssets(timestamp, options),
    copy: (assets) => downloadAssets(assets, timestamp, options),
    rewrite: () => updateBundleUrls(timestamp, baseUrl, options),
  };
}

async function serveFixture(t, tree) {
  const serverDir = path.join(tree.projectRoot, "server");
  for (const file of ["serve.js", "legacy-payment-return.js", "templates/landing-page.html"]) {
    tree.write(path.join(serverDir, file), fs.readFileSync(path.join(__dirname, file)));
  }
  const entry = path.join(serverDir, "serve.js");
  const previous = process.env.BASE_PATH;
  let server;
  try {
    process.env.BASE_PATH = tree.basePath;
    server = require(entry);
  } finally {
    if (previous === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = previous;
  }
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    delete require.cache[entry];
    delete require.cache[path.join(serverDir, "legacy-payment-return.js")];
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

for (const basePath of ["/", "/mobile/"]) {
  test(`bundle-only variants are copied and served byte-for-byte at ${basePath}`, async (t) => {
    const tree = fixture(t, basePath);
    const common = registration("assets/images", "logo", "png", [1, 1.5, 2, 3], "shared");
    const icon = registration("assets/images", "button", "png", [1, 2]);
    const font = registration("node_modules/@fixture/fonts", "Icon", "ttf");
    const genericFont = registration("assets/fonts", "Body", "otf");
    const highDensity = registration("assets/images", "splash", "png", [2, 3]);
    const nativeImage = registration("assets/images", "badge.native", "png");
    const remote = 'const remote={httpServerLocation:"https://cdn.example.test/images",scales:[1],hash:"remote",name:"remote",type:"png"};';
    const expected = [];
    for (const platform of platforms) {
      // Deliberate duplicate registration must not cause duplicate copies.
      tree.bundle(platform, [common, common, icon, font, genericFont, highDensity, nativeImage, remote].join("\n"));
      for (const [directory, name, type, scales, specific, workspace] of [
        ["assets/images", "logo", "png", [1, 1.5, 2, 3], false, false],
        ["assets/images", "button", "png", [1, 2], true, false],
        ["node_modules/@fixture/fonts", "Icon", "ttf", [1], true, true],
        ["assets/fonts", "Body", "otf", [1], false, false],
        ["assets/images", "splash", "png", [2, 3], false, false],
        ["assets/images", "badge.native", "png", [1], false, false],
      ]) {
        for (const scale of scales) {
          const stem = `${name}${scale === 1 ? "" : `@${scale}x`}`;
          const bytes = Buffer.from(`${specific ? platform : "shared"}:${stem}.${type}\0\xff`);
          tree.source(`${directory}/${stem}${specific ? `.${platform}` : ""}.${type}`, bytes, workspace);
          expected.push({ platform, directory, filename: `${stem}.${type}`, bytes });
          if (specific) {
            // A generic fallback exists, but must not override platform bytes.
            tree.source(`${directory}/${stem}.${type}`, "wrong generic bytes", workspace);
          }
        }
      }
    }
    // Do not copy extra scales just because they happen to exist on disk.
    tree.source("assets/images/logo@4x.png", "not registered");
    const assets = tree.extract();
    assert.equal(assets.length, 12);
    for (const platform of platforms) {
      assert.equal(assets.filter((asset) => asset.platforms.has(platform)).length, 6);
    }
    assert.equal(await tree.copy(assets), expected.length);
    tree.rewrite();

    const manifests = Object.fromEntries(platforms.map((platform) => [platform, {
      launchAsset: {}, assets: [],
      extra: { expoClient: {}, expoGo: { packagerOpts: {} } },
    }]));
    updateManifests(manifests, timestamp, baseUrl, new Map(), tree.options);
    // The old manifest-only check passes with just two bundles: the assertions
    // below independently verify every additional bundle-registered variant.
    assert.deepEqual(checkNativeBuild({
      staticRoot: path.join(tree.projectRoot, "static-build"), baseUrl, basePath,
    }), { checkedFiles: 2 });

    const origin = await serveFixture(t, tree);
    const prefix = basePath.replace(/\/+$/, "");
    for (const { platform, directory, filename, bytes } of expected) {
      const rewritten = fs.readFileSync(tree.bundlePath(platform), "utf8");
      const location = `${baseUrl}${prefix}/${timestamp}/_expo/static/js/${platform}/${directory}`;
      assert.ok(rewritten.includes(`httpServerLocation:"${location}"`));
      assert.ok(!rewritten.includes("unstable_path"));
      assert.ok(rewritten.includes('httpServerLocation:"https://cdn.example.test/images"'));
      const response = await fetch(`${origin}${new URL(`${location}/${filename}`).pathname}`);
      assert.equal(response.status, 200, `${platform}/${directory}/${filename}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    const extra = await fetch(`${origin}${prefix}/${timestamp}/_expo/static/js/ios/assets/images/logo@4x.png`);
    assert.equal(extra.status, 404);
    const old = await fetch(`${origin}${prefix}/older-build/_expo/static/js/ios/assets/images/logo.png`);
    assert.equal(old.status, 404);
  });
}

test("platform manifests use their own hash mapping, including equal cross-platform hashes", async (t) => {
  const tree = fixture(t, "/mobile/");
  for (const platform of platforms) {
    tree.bundle(platform, registration(`assets/${platform}`, "icon", "png", [1], "same-hash"));
    tree.source(`assets/${platform}/icon.png`, platform);
  }
  const assets = tree.extract();
  await tree.copy(assets);
  const byHash = new Map(assets.map((asset) => [
    `${[...asset.platforms][0]}:${asset.hash}`, asset,
  ]));
  const manifests = Object.fromEntries(platforms.map((platform) => [platform, {
    launchAsset: {}, assets: [{ hash: "same-hash", url: "http://localhost:8081/original" }],
    extra: { expoClient: {}, expoGo: { packagerOpts: {} } },
  }]));
  updateManifests(manifests, timestamp, baseUrl, byHash, tree.options);
  for (const platform of platforms) {
    const saved = JSON.parse(fs.readFileSync(path.join(tree.projectRoot, "static-build", platform, "manifest.json")));
    assert.equal(saved.assets[0].url,
      `${baseUrl}/mobile/${timestamp}/_expo/static/js/${platform}/assets/${platform}/icon.png`);
  }
});

test("a manifest uses the lowest registered scale when no unscaled file exists", async (t) => {
  const tree = fixture(t);
  for (const platform of platforms) {
    tree.bundle(platform, registration("assets", "retina", "png", [2, 3]));
  }
  tree.source("assets/retina@2x.png", "two");
  tree.source("assets/retina@3x.png", "three");
  const assets = tree.extract();
  assert.ok(assets.every((asset) => asset.filename === "retina@2x.png"));
  await tree.copy(assets);
  const byHash = new Map(assets.map((asset) => [
    `${[...asset.platforms][0]}:${asset.hash}`, asset,
  ]));
  const manifests = Object.fromEntries(platforms.map((platform) => [platform, {
    launchAsset: {}, assets: [{ hash: "retina", url: "http://localhost:8081/original" }],
    extra: { expoClient: {}, expoGo: { packagerOpts: {} } },
  }]));
  updateManifests(manifests, timestamp, baseUrl, byHash, tree.options);
  assert.deepEqual(checkNativeBuild({
    staticRoot: path.join(tree.projectRoot, "static-build"), baseUrl,
  }), { checkedFiles: 4 });
});

for (const platform of platforms) {
  for (const type of ["png", "ttf"]) {
    test(`missing ${platform} bundle-only ${type} fails without a generic fallback`, async (t) => {
      const tree = fixture(t);
      tree.bundle(platform, registration("assets/local", "missing", type, type === "png" ? [1, 2] : [1]));
      if (type === "png") {
        tree.source(`assets/local/missing.${platform}.${type}`, "base variant");
      }
      // A different platform's density variant must never satisfy this reference.
      const missingName = type === "png" ? `missing@2x.${platform}.png` : "missing.ttf";
      tree.source(`assets/local/missing${type === "png" ? "@2x" : ""}.${platform === "ios" ? "android" : "ios"}.${type}`, "wrong platform");
      await assert.rejects(tree.copy(tree.extract()), (error) => {
        assert.match(error.message, /Failed to download/);
        assert.ok(error.message.includes(missingName));
        return true;
      });
    });
  }
}

for (const mode of ["empty", "directory", "missing"]) {
  test(`${mode} source cannot be satisfied by an old timestamp's copy`, async (t) => {
    const tree = fixture(t);
    tree.bundle("ios", registration("assets", "image", "png"));
    tree.write(path.join(tree.projectRoot, "static-build/old/_expo/static/js/ios/assets/image.png"), "old");
    const source = path.join(tree.projectRoot, "assets/image.png");
    if (mode === "empty") tree.source("assets/image.png", "");
    if (mode === "directory") fs.mkdirSync(source, { recursive: true });
    await assert.rejects(tree.copy(tree.extract()), /Failed to download/);
  });
}

test("missing unstable_path fails extraction and rewriting explicitly", (t) => {
  const tree = fixture(t);
  tree.bundle("android", registration("assets", "icon", "png").replace(
    /\/assets\/\?unstable_path=[^"]+/, "/assets/",
  ));
  assert.throws(tree.extract, /Asset missing unstable_path/);
  assert.throws(tree.rewrite, /Asset missing unstable_path in bundle/);
});

test("asset-free bundles need no files and keep their contents on rewrite", async (t) => {
  const tree = fixture(t);
  assert.deepEqual(tree.extract(), []);
  assert.equal(await tree.copy([]), 0);
  tree.rewrite();
  for (const platform of platforms) {
    assert.equal(fs.readFileSync(tree.bundlePath(platform), "utf8"), "// fixture bundle\n");
  }
});

test("extraction never evaluates bundle code or starts Metro/network work", (t) => {
  const tree = fixture(t);
  tree.bundle("ios", `throw new Error("bundle must not run");\n${registration("assets", "icon", "png")}`);
  const spawn = t.mock.method(require("node:child_process"), "spawn", () => {
    throw new Error("must not spawn Metro");
  });
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("must not contact any service");
  });
  assert.equal(tree.extract().length, 1);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});
