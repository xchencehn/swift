'use strict';
// Keep offline/browser/Android/desktop assets identical, including local patches.
const fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve(__dirname, '../..');
const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'LICENSE-xterm'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'LICENSE-addon-fit'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['@xterm/addon-web-links/LICENSE', 'LICENSE-addon-web-links'],
];
for (const [source, target] of files) {
  const original = fs.readFileSync(path.join(root, 'node_modules', source));
  const expected =
    target === 'xterm.js'
      ? require('./patches/xterm-ime').patchXterm(original)
      : target === 'xterm.css'
        ? Buffer.from(original.toString() + require('./patches/xterm-braille').brailleCss())
        : original;
  const destination = path.join(root, 'public/vendor/xterm', target);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(expected))
      throw new Error(`Terminal asset differs: ${target}`);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, expected);
  }
}
console.log('Terminal assets match the pinned npm packages and reviewed local patches.');
