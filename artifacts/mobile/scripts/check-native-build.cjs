const fs = require("node:fs");
const path = require("node:path");
const { registrationPattern, stringField } = require("./native-asset-strings.cjs");

function isDevelopmentUrl(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // An unmatched asset hash can leave Metro's original URL in the manifest.
  // These are not intentional remote assets: they point at the builder/LAN.
  return host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::" || host === "::1" || host.startsWith("::ffff:") ||
    /^(?:fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) ||
    url.port === "8081" || url.searchParams.has("unstable_path");
}

/**
 * Check the files serve.js will serve, not Metro's original asset paths.
 * Absolute same-origin URLs and relative URLs are local; external HTTP(S)
 * assets remain remote and are never fetched by this check.
 */
function checkNativeBuild({ staticRoot, baseUrl, basePath = "/" }) {
  const origin = new URL(baseUrl).origin;
  const prefix = basePath.replace(/\/+$/, "");
  const root = path.resolve(staticRoot);
  const errors = [];
  let checkedFiles = 0;

  function checkReference(platform, field, value, launch = false) {
    const label = `${platform} ${field}`;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label}: missing URL`);
      return;
    }
    let url;
    try {
      // Relative references resolve from the platform manifest endpoint.
      url = new URL(value, `${origin}${prefix}/manifest`);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      errors.push(`${label}: invalid HTTP(S) URL ${value}`);
      return;
    }
    if (isDevelopmentUrl(url)) {
      errors.push(`${label}: development-server URL remains in published manifest (${value})`);
      return;
    }
    if (url.origin !== origin) {
      if (launch) errors.push(`${label}: launch bundle must be local (${value})`);
      return;
    }

    // Match serve.js: strip BASE_PATH when present, keep unprefixed paths,
    // ignore the query, and URL-decode the pathname exactly once.
    let pathname = url.pathname;
    if (prefix && pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length) || "/";
    }
    try {
      pathname = decodeURIComponent(pathname);
      if (pathname.includes("\0")) throw new Error("NUL in asset URL");
    } catch {
      errors.push(`${label}: invalid escaped asset URL (${value})`);
      return;
    }
    const filePath = path.join(root, pathname);
    const relative = path.relative(root, filePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push(`${label}: URL escapes static-build (${value})`);
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) {
        errors.push(`${label}: expected a non-empty file at ${filePath} (${value})`);
        return;
      }
      checkedFiles++;
      return filePath;
    } catch (error) {
      errors.push(`${label}: cannot read ${filePath} (${value}): ${error.code}`);
    }
  }

  function checkBundle(platform, bundlePath) {
    let bundle;
    try {
      bundle = fs.readFileSync(bundlePath, "utf8");
    } catch (error) {
      errors.push(`${platform} bundle: cannot read ${bundlePath}: ${error.code}`);
      return;
    }
    // Match Metro's plain asset objects without executing application code.
    // Inspect the persisted URLs, not the source paths used by the copy step.
    const pattern = registrationPattern();
    const seen = new Set();
    let index = 0;
    for (const match of bundle.matchAll(pattern)) {
      const label = `bundle assets[${index++}]`;
      try {
        const registration = match[0];
        const field = (name) => stringField(registration, name);
        const location = field("httpServerLocation");
        const name = field("name");
        const type = field("type");
        const scaleList = registration.match(/\bscales\s*:\s*(\[[^\]]*\])/);
        if (!scaleList) throw new Error("missing scales");
        const scales = JSON.parse(scaleList[1]);
        if (!Array.isArray(scales) || !scales.length ||
            scales.some((scale) => !Number.isFinite(scale) || scale <= 0)) {
          throw new Error("invalid scales");
        }
        if (!location.trim() || !name || !type || /[\\/?#]/.test(name + type)) {
          throw new Error("invalid asset location, name or type");
        }
        const directory = new URL(location, `${origin}${prefix}/manifest`);
        // Append to the pathname so a leftover unstable_path query is retained
        // and rejected, rather than silently discarded when adding a filename.
        for (const scale of scales) {
          const url = new URL(directory);
          url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(`${name}${scale === 1 ? "" : `@${scale}x`}.${type}`)}`;
          if (seen.has(url.href)) continue;
          seen.add(url.href);
          checkReference(platform, `${label} ${name}.${type} scale ${scale}`, url.href);
        }
      } catch (error) {
        errors.push(`${platform} ${label}: invalid registration: ${error.message}`);
      }
    }
  }

  for (const platform of ["ios", "android"]) {
    const manifestPath = path.join(root, platform, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("expected a manifest object");
      }
    } catch (error) {
      errors.push(`${platform}: cannot read manifest ${manifestPath}: ${error.message}`);
      continue;
    }
    const bundlePath = checkReference(platform, "launchAsset.url", manifest.launchAsset?.url, true);
    if (bundlePath) checkBundle(platform, bundlePath);
    if (manifest.assets !== undefined && !Array.isArray(manifest.assets)) {
      errors.push(`${platform} assets: expected an array`);
      continue;
    }
    for (const [index, asset] of (manifest.assets || []).entries()) {
      checkReference(platform, `assets[${index}].url`, asset?.url);
    }
  }
  if (errors.length) {
    throw new Error(`Native build is incomplete:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  return { checkedFiles };
}

module.exports = { checkNativeBuild };
