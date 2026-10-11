// Copies browser libraries from node_modules into public/vendor so the app
// works without a CDN.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(path.join(out, 'images'), { recursive: true });
const copies = [
  ['node_modules/jsqr/dist/jsQR.js', 'jsQR.js'],
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet.css'],
  ['node_modules/leaflet/dist/images/marker-icon.png', 'images/marker-icon.png'],
  ['node_modules/leaflet/dist/images/marker-icon-2x.png', 'images/marker-icon-2x.png'],
  ['node_modules/leaflet/dist/images/marker-shadow.png', 'images/marker-shadow.png'],
];
for (const [src, dst] of copies) {
  const from = path.join(root, src);
  if (!fs.existsSync(from)) { console.warn('vendor: missing', src); continue; }
  fs.copyFileSync(from, path.join(out, dst));
}
console.log('vendor: browser libraries copied to public/vendor');
