'use strict';
// xterm 6.0.0's DOM renderer uses font glyphs for Braille. Draw their standard
// 2x4 dot grid across the full cell so font fallback and line spacing cannot
// introduce stripes in terminal graphics. The Unicode text remains selectable.
function patchBrailleRow(original) {
  const replacements = [
    ['{const m=[]', '{let swiftLastBraille=-1;const m=[]'],
    ['let j=F.getChars()||o.WHITESPACE_CELL_CHAR;',
      'const swiftBraille=F.getCode()-0x2800;const swiftBrailleCell=swiftBraille>=0&&swiftBraille<256&&C===1&&!B&&!F.isInvisible();const swiftBrailleKey=swiftBrailleCell?swiftBraille:-1;let j=F.getChars()||o.WHITESPACE_CELL_CHAR;'],
    ['if(y&&', 'if(y&&swiftBrailleKey===swiftLastBraille&&'],
    ['y++;continue', 'swiftBrailleCell&&(b.style.width=`${(y+1)*c}px`),y++;continue'],
    ['I.length&&(b.className=I.join(" "),I.length=0)',
      'swiftLastBraille=swiftBrailleKey,swiftBrailleCell&&(b.style.setProperty("--xterm-braille-cell-width",`${c}px`),b.style.setProperty("--xterm-braille",this._brailleImage(swiftBraille,H&&!this._coreService.isCursorHidden&&this._coreService.isCursorInitialized&&this._coreBrowserService.isFocused&&s==="block"?S.cursorAccent.css:b.style.color||((V===16777216||V===33554432)?S.ansi[$].css:X?S.background.css:S.foreground.css))),I.push("xterm-braille"),b.style.width=`${c}px`),I.length&&(b.className=I.join(" "),I.length=0)'],
  ];
  for (const [from, to] of replacements) {
    if (original.split(from).length !== 2) throw new Error('xterm Braille row implementation changed.');
    original = original.replace(from, to);
  }
  return original + "\n" + BrailleImages.prototype._brailleImage.toString();
}
class BrailleImages {
  _brailleImage(bits, color) {
    const cache = this._brailleImages || (this._brailleImages = new Map());
    const key = bits + ':' + color;
    let image = cache.get(key);
    if (image) return image;
    const dots = [[.5,.5],[.5,1.5],[.5,2.5],[1.5,.5],[1.5,1.5],[1.5,2.5],[.5,3.5],[1.5,3.5]];
    const circles = dots.map(([x,y], bit) => bits & 1 << bit ? `<circle cx="${x}" cy="${y}" r=".22"/>` : '').join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 4" preserveAspectRatio="none" fill="${color}">${circles}</svg>`;
    image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    cache.set(key, image); return image;
  }
}
function brailleCss() {
  return '\n/* Full-cell Unicode Braille; foreground, selection and cursor stay native. */\n'
    + '.xterm .xterm-braille { position: relative; height: 100%; vertical-align: top; -webkit-text-fill-color: transparent; letter-spacing: 0 !important; }\n'
    + '.xterm .xterm-braille::after { content: ""; position: absolute; inset: 0; pointer-events: none; background-image: var(--xterm-braille); background-size: var(--xterm-braille-cell-width) 100%; background-repeat: repeat-x; }\n';
}
module.exports = { patchBrailleRow, brailleCss };
