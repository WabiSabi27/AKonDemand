const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('publishing does not explicitly exclude the generated website', () => {
  const workspaceRoot = path.resolve(__dirname, '../../..');
  const rules = fs.readFileSync(path.join(workspaceRoot, '.replitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));

  // The publisher applies exclusions after builds too. Excluding web-dist
  // removes index.html from an otherwise successful build and crashes startup.
  assert.deepEqual(
    rules.filter((rule) => /(?:^|\/)web-dist(?:\/|$)/.test(rule)),
    [],
    'The generated website must be included in the published runtime image',
  );
});
