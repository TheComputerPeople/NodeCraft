// Writes out/marketplace/README.md, the README the Marketplace shows (npm run package passes it to
// vsce with --readme-path). NodeCraft has no public source repository, so a link to another file in
// it (docs/..., LICENSING.md) would lead nowhere on the Marketplace: each becomes its text. Links to
// web pages and to the README's own headings are kept. The License link in the Marketplace's sidebar
// shows LICENSING.md from the package itself.
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
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, marketplaceReadme(fs.readFileSync(path.join(root, 'README.md'), 'utf8')));
  console.log(`Wrote ${path.relative(root, out)}`);
}

module.exports = { marketplaceReadme };
