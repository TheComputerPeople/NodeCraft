// Writes out/marketplace/README.md, the README the Marketplace shows (npm run package passes it to
// vsce with --readme-path). When package.json names a repository, it's the README as it is: vsce
// rewrites its links to other files (docs/..., LICENSING.md) to that repository. Without one, those
// links would lead nowhere on the Marketplace, so each becomes its text; links to web pages and to
// the README's own headings are kept. The License link in the Marketplace's sidebar shows
// LICENSING.md from the package itself.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// The README with links to other files turned into their text.
function marketplaceReadme(text) {
  return text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (link, image, label, target) => {
    if (image || /^(https?:|mailto:|#)/.test(target)) return link;
    return label;
  });
}

if (require.main === module) {
  const out = path.join(root, 'out', 'marketplace', 'README.md');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const { repository } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, repository ? readme : marketplaceReadme(readme));
  console.log(`Wrote ${path.relative(root, out)}`);
}

module.exports = { marketplaceReadme };
