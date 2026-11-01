const { parseSync } = require("@babel/core");

// Metro/minifiers emit JavaScript literals, not necessarily JSON strings.
// Parse only the matched literal as data; never evaluate registration or app code.
const stringLiteral = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;

function decodeString(literal) {
  const ast = parseSync(`(${literal})`, {
    babelrc: false, configFile: false, sourceType: "script",
  });
  const value = ast.program.body[0]?.expression;
  if (value?.type !== "StringLiteral") throw new Error("Expected an asset string literal");
  return value.value;
}

function stringField(registration, name) {
  const match = registration.match(new RegExp(`\\b${name}\\s*:\\s*(${stringLiteral})`));
  if (!match) throw new Error(`missing ${name}`);
  return decodeString(match[1]);
}

function registrationPattern() {
  return new RegExp(`\\{[^{}]*\\bhttpServerLocation\\s*:\\s*(?:${stringLiteral})[^{}]*\\}`, "g");
}

function encodeAssetPath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

module.exports = { stringLiteral, decodeString, stringField, registrationPattern, encodeAssetPath };
