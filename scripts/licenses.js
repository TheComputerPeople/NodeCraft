// The licenses NodeCraft can include third-party code under (CONTRIBUTING.md, "Licenses of what you
// add"; docs/licensing.md): ones that allow it under the GPL-3.0 it has now and under the other
// licenses its CLA allows later. Code available only under the GPL, LGPL or AGPL would tie it to the
// GPL. Used by scripts/check-package.js and test/unit/licensing.test.ts.
'use strict';

const ALLOWED = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'EPL-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0']);

// Whether a package's SPDX license expression ("MIT", "EPL-2.0 OR GPL-3.0-or-later") offers one of
// the allowed licenses. An AND expression needs every part allowed.
function allowedLicense(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .some((option) => option.trim().split(/\s+AND\s+/i).every((part) => ALLOWED.has(part.trim())));
}

module.exports = { ALLOWED, allowedLicense };
