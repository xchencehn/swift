'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../public/device-theme');

test('device theme validates stored choices and preserves the existing default', () => {
  assert.equal(theme.get('default').colors.bg, '#17171a');
  assert.deepEqual(
    theme.palettes.map((palette) => [palette.id, palette.label]),
    [
      ['default', '深色'],
      ['light', '浅色'],
    ],
  );
  for (const invalid of ['black', 'soft', null, '', '__proto__', 'unknown'])
    assert.equal(theme.get(invalid).id, 'default');
  const keys = Object.keys(theme.get('default').colors).sort();
  for (const palette of theme.palettes) assert.deepEqual(Object.keys(palette.colors).sort(), keys);
});

test('terminal colors remain colored and readable on the light background', () => {
  const light = theme.get('light');
  for (const input of ['rgb(229,229,16)', 'rgb(255,255,255)', 'rgb(35,209,139)', '#8fc7ff']) {
    const result = theme.readableColor(input, light);
    assert.notEqual(result, input);
    const channels = result.match(/\d+/g).map(Number);
    const lum = channels.reduce(
      (sum, v, i) =>
        sum +
        (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][i],
      0,
    );
    const background = light.colors.bg
      .slice(1)
      .match(/../g)
      .map((hex) => parseInt(hex, 16) / 255)
      .reduce(
        (sum, v, i) =>
          sum +
          (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i],
        0,
      );
    assert((background + 0.05) / (lum + 0.05) >= 4.5);
    assert.equal(theme.readableColor(input, theme.get('default')), input);
  }
});

test('unavailable device storage still allows a local in-memory theme', () => {
  const properties = new Map(),
    events = new Map();
  const host = {
    document: {
      documentElement: { dataset: {}, style: { setProperty: (k, v) => properties.set(k, v) } },
      querySelector: () => null,
    },
    localStorage: {
      getItem() {
        throw Error('denied');
      },
      setItem() {
        throw Error('denied');
      },
    },
    CustomEvent: class {},
    dispatchEvent() {},
    addEventListener: (k, v) => events.set(k, v),
  };
  theme.start(host);
  theme.apply('default');
  assert.equal(host.document.documentElement.dataset.deviceTheme, 'default');
  const color = theme.terminalColor('rgb(255,255,255)');
  theme.apply('light');
  assert.equal(color, 'var(--terminal-255-255-255)');
  assert.notEqual(properties.get('--terminal-255-255-255'), 'rgb(255,255,255)');
  assert.equal(events.has('storage'), false);
});
