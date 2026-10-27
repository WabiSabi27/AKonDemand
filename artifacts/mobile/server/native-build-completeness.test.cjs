const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkNativeBuild } = require("../scripts/check-native-build.cjs");

const baseUrl = "https://native.example.test";
const buildId = "1792756800000-123";

function fixture(t, basePath) {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "expo-build-completeness-"));
  t.after(() => fs.rmSync(staticRoot, { recursive: true, force: true }));
  const prefix = basePath.replace(/\/+$/, "");
  const files = {};
  const manifests = {};
  function write(relative, contents) {
    const target = path.join(staticRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
  }
  function save(platform) {
    write(`${platform}/manifest.json`, JSON.stringify(manifests[platform]));
  }
  for (const platform of ["ios", "android"]) {
    const bundle = `${buildId}/_expo/static/js/${platform}/bundle.js`;
    const image = `${buildId}/_expo/static/js/assets/${platform}/icon.png`;
    const font = `${buildId}/_expo/static/js/node_modules/fonts/${platform}.ttf`;
    files[platform] = {
      bundle: write(bundle, `// ${platform} bundle\n`),
      image: write(image, Buffer.from([137, 80, 78, 71])),
      font: write(font, Buffer.from([0, 1, 0, 0])),
    };
    // Match updateManifests' timestamped URLs and nested copied-asset layout.
    manifests[platform] = {
      launchAsset: { url: `${baseUrl}${prefix}/${bundle}` },
      assets: [
        { url: `${baseUrl}${prefix}/${image}?platform=${platform}&hash=fixture` },
        { url: `${baseUrl}${prefix}/${font}` },
        { url: "https://cdn.example.test/remote.png" },
      ],
    };
    save(platform);
  }
  return {
    staticRoot, files, manifests, save,
    check: () => checkNativeBuild({ staticRoot, baseUrl, basePath }),
  };
}

for (const basePath of ["/", "/mobile/"]) {
  test(`complete native build at BASE_PATH=${basePath}`, (t) => {
    const tree = fixture(t, basePath);
    assert.deepEqual(tree.check(), { checkedFiles: 6 });
  });

  for (const platform of ["ios", "android"]) {
    for (const kind of ["bundle", "image", "font"]) {
      test(`missing ${platform} ${kind} fails at BASE_PATH=${basePath}`, (t) => {
        const tree = fixture(t, basePath);
        fs.unlinkSync(tree.files[platform][kind]);
        assert.throws(tree.check, (error) => {
          assert.match(error.message, /Native build is incomplete/);
          assert.ok(error.message.includes(`${platform} ${kind === "bundle" ? "launchAsset.url" : "assets["}`));
          assert.ok(error.message.includes(tree.files[platform][kind]));
          return true;
        });
      });
    }
  }
}

test("relative and unprefixed same-origin references follow the server mapping", (t) => {
  const tree = fixture(t, "/mobile/");
  const manifest = tree.manifests.ios;
  manifest.launchAsset.url = manifest.launchAsset.url.replace(`${baseUrl}/mobile/`, "");
  manifest.assets[0].url = manifest.assets[0].url.replace(`${baseUrl}/mobile`, "");
  manifest.assets[1].url = manifest.assets[1].url.replace("/mobile/", "/");
  tree.save("ios");
  assert.deepEqual(tree.check(), { checkedFiles: 6 });
});

test("a file at the wrong build timestamp cannot satisfy a reference", (t) => {
  const tree = fixture(t, "/mobile/");
  tree.manifests.android.launchAsset.url = tree.manifests.android.launchAsset.url.replace(buildId, "older-build");
  tree.save("android");
  assert.throws(tree.check, /android launchAsset\.url:.*older-build/);
});

for (const replacement of ["empty", "directory"]) {
  test(`${replacement} output cannot satisfy a manifest reference`, (t) => {
    const tree = fixture(t, "/mobile/");
    for (const file of [tree.files.ios.bundle, tree.files.android.image]) {
      fs.unlinkSync(file);
      if (replacement === "empty") fs.writeFileSync(file, "");
      else fs.mkdirSync(file);
    }
    assert.throws(tree.check, (error) => {
      assert.match(error.message, /ios launchAsset\.url: expected a non-empty file/);
      assert.match(error.message, /android assets\[0\]\.url: expected a non-empty file/);
      return true;
    });
  });
}

for (const platform of ["ios", "android"]) {
  for (const mode of ["missing", "invalid JSON"]) {
    test(`${mode} ${platform} manifest fails explicitly`, (t) => {
      const tree = fixture(t, "/mobile/");
      const target = path.join(tree.staticRoot, platform, "manifest.json");
      if (mode === "missing") fs.unlinkSync(target);
      else fs.writeFileSync(target, "{broken");
      assert.throws(tree.check, new RegExp(`${platform}: cannot read manifest`));
    });
  }
}

test("missing and malformed references fail instead of being skipped", (t) => {
  const tree = fixture(t, "/");
  delete tree.manifests.ios.launchAsset;
  tree.manifests.android.assets = [{}, { url: "http://[" }, { url: "file:///tmp/icon.png" }];
  tree.save("ios");
  tree.save("android");
  assert.throws(tree.check, (error) => {
    assert.match(error.message, /ios launchAsset\.url: missing URL/);
    assert.match(error.message, /android assets\[0\]\.url: missing URL/);
    assert.match(error.message, /android assets\[1\]\.url: invalid HTTP/);
    assert.match(error.message, /android assets\[2\]\.url: invalid HTTP/);
    return true;
  });
});

test("remote assets need no local file but a remote launch bundle is rejected", (t) => {
  const tree = fixture(t, "/");
  tree.manifests.ios.launchAsset.url = "https://other.example.test/bundle.js";
  tree.save("ios");
  assert.throws(tree.check, /ios launchAsset\.url: launch bundle must be local/);
});

for (const metroUrl of [
  "http://localhost:8081/assets/icon.png?unstable_path=assets",
  "http://127.0.0.1:8081/assets/icon.png",
  "http://127.1.2.3/assets/icon.png",
  "http://0.0.0.0:8081/assets/icon.png",
  "http://[::1]:8081/assets/icon.png",
  "http://[::ffff:127.0.0.1]/assets/icon.png",
  "http://10.0.0.2:8081/assets/icon.png",
  "http://192.168.1.2/assets/icon.png",
  "http://172.16.0.2/assets/icon.png",
  "http://169.254.1.2/assets/icon.png",
  "http://builder.local/assets/icon.png",
  "http://metro.localhost/assets/icon.png",
  "http://metro.example.test:8081/assets/icon.png",
  "https://metro.example.test/assets/icon.png?unstable_path=assets",
]) {
  test(`unmatched manifest asset retaining Metro URL fails: ${metroUrl}`, (t) => {
    const tree = fixture(t, "/mobile/");
    // updateManifests leaves the original URL unchanged when assetsByHash
    // has no match; represent that exact persisted output, not a CDN asset.
    tree.manifests.android.assets.push({ hash: "not-extracted-from-bundle", url: metroUrl });
    tree.save("android");
    assert.throws(tree.check, (error) => {
      assert.match(error.message, /android assets\[3\]\.url: development-server URL remains/);
      assert.ok(error.message.includes(metroUrl));
      return true;
    });
  });
}

test("an asset-free manifest is valid but a malformed asset list is not", (t) => {
  const tree = fixture(t, "/");
  delete tree.manifests.ios.assets;
  tree.manifests.android.assets = [];
  tree.save("ios");
  tree.save("android");
  assert.deepEqual(tree.check(), { checkedFiles: 2 });
  tree.manifests.android.assets = {};
  tree.save("android");
  assert.throws(tree.check, /android assets: expected an array/);
});

test("the native build checks persisted output before reporting success", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/build.js"), "utf8");
  assert.match(source, /require\("\.\/check-native-build\.cjs"\)/);
  const update = source.indexOf("  updateManifests(manifests, timestamp, baseUrl, assetsByHash);");
  const check = source.indexOf("  const { checkedFiles } = checkNativeBuild({");
  const success = source.indexOf('  console.log("Build complete!');
  assert.ok(update >= 0 && check > update && success > check);
  assert.match(source.slice(check, success), /staticRoot: path\.join\(projectRoot, "static-build"\),\s*baseUrl,\s*basePath,/);
});
