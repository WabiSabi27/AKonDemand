const fs = require("node:fs");
const path = require("node:path");

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
    // ignore the query, and do not URL-decode the pathname.
    let pathname = url.pathname;
    if (prefix && pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length) || "/";
    }
    const filePath = path.join(root, path.normalize(pathname));
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
    } catch (error) {
      errors.push(`${label}: cannot read ${filePath} (${value}): ${error.code}`);
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
    checkReference(platform, "launchAsset.url", manifest.launchAsset?.url, true);
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
