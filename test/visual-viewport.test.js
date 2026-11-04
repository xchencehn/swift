'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VisualViewport = require('../public/visual-viewport');

test('isTouchDevice recognizes coarse pointers and touch points', () => {
  assert.equal(VisualViewport.isTouchDevice({ navigator: { maxTouchPoints: 1 } }), true);
  assert.equal(
    VisualViewport.isTouchDevice({
      navigator: { maxTouchPoints: 0 },
      matchMedia: () => ({ matches: true }),
    }),
    true,
  );
  assert.equal(
    VisualViewport.isTouchDevice({
      navigator: { maxTouchPoints: 0 },
      matchMedia: () => ({ matches: false }),
    }),
    false,
  );
});

test('visual viewport binding publishes the height and cleans up after itself', () => {
  const listeners = new Map();
  const styles = new Map();
  const rootElement = {
    style: {
      setProperty: (key, value) => styles.set(key, value),
      removeProperty: (key) => styles.delete(key),
    },
  };
  const visualViewport = {
    height: 612.4,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  let changed = 0;
  const binding = VisualViewport.bindVisualViewport({
    rootElement,
    visualViewport,
    enabled: true,
    onChange: () => {
      changed += 1;
    },
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
  });
  assert.equal(styles.get('--visual-viewport-height'), '612px');
  assert.equal(changed, 1);
  assert.deepEqual([...listeners.keys()].sort(), ['resize', 'scroll']);
  binding.destroy();
  assert.equal(styles.has('--visual-viewport-height'), false);
  assert.equal(listeners.size, 0);
});

test('visual viewport binding stays inert where there is no soft keyboard', () => {
  // 桌面没有软键盘,挂上去只是白占两个监听;拿不到 visualViewport 的浏览器同理。
  const binding = VisualViewport.bindVisualViewport({
    rootElement: {
      style: {
        setProperty() {
          throw new Error('不该写样式');
        },
        removeProperty() {},
      },
    },
    visualViewport: {
      addEventListener() {
        throw new Error('不该挂监听');
      },
      removeEventListener() {},
    },
    enabled: false,
  });
  binding.sync();
  binding.destroy();
});
test('keyboard viewport includes panning and the resized WebView bounds, preserving the pre-resize state', () => {
  const styles = new Map(),
    listeners = new Map(),
    windowListeners = new Map(),
    attributes = new Map();
  const rootElement = {
    style: { setProperty: (k, v) => styles.set(k, v), removeProperty: (k) => styles.delete(k) },
    setAttribute: (k, v) => attributes.set(k, v),
    removeAttribute: (k) => attributes.delete(k),
  };
  const visualViewport = {
    height: 844,
    offsetTop: 0,
    addEventListener: (k, v) => listeners.set(k, v),
    removeEventListener: (k) => listeners.delete(k),
  };
  const viewportWindow = {
    innerHeight: 844,
    addEventListener: (k, v) => windowListeners.set(k, v),
    removeEventListener: (k) => windowListeners.delete(k),
  };
  let changes = 0;
  const binding = VisualViewport.bindVisualViewport({
    rootElement,
    visualViewport,
    viewportWindow,
    enabled: true,
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
    onBeforeChange: () => styles.get('--visual-viewport-height'),
    onChange: (previous) => {
      if (changes === 1) assert.equal(previous, '844px');
      changes++;
    },
  });
  visualViewport.height = 430;
  visualViewport.offsetTop = 32;
  listeners.get('resize')();
  assert.equal(styles.get('--visual-viewport-height'), '430px');
  assert.equal(styles.get('--visual-viewport-offset-top'), '32px');
  listeners.get('scroll')();
  assert.equal(changes, 2, 'Duplicate viewport events must not reapply layout');
  viewportWindow.innerHeight = 400;
  windowListeners.get('resize')();
  assert.equal(styles.get('--visual-viewport-height'), '400px');
  binding.destroy();
  assert.equal(styles.size, 0);
  assert.equal(attributes.size, 0);
  assert.equal(windowListeners.size, 0);
});

test('closing the keyboard expands a resized WebView even without input blur', () => {
  const styles = new Map(),
    listeners = new Map();
  const input = { matches: (selector) => selector.startsWith('input:') };
  const viewportWindow = {
    innerHeight: 430,
    document: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const binding = VisualViewport.bindVisualViewport({
    rootElement: {
      style: {
        setProperty: (key, value) => styles.set(key, value),
        removeProperty: (key) => styles.delete(key),
      },
    },
    visualViewport: { height: 430, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
    viewportWindow,
    enabled: true,
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
  });
  viewportWindow.innerHeight = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  listeners.get('focusout')({ target: input });
  binding.destroy();
  assert.equal(listeners.size, 0);
});

test('editable focus immediately clears a restored layout height without another resize event', () => {
  const styles = new Map(),
    listeners = new Map();
  const visualViewport = {
    height: 430,
    offsetTop: 32,
    addEventListener() {},
    removeEventListener() {},
  };
  const viewportWindow = {
    innerHeight: 430,
    document: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const binding = VisualViewport.bindVisualViewport({
    rootElement: {
      style: {
        setProperty: (key, value) => styles.set(key, value),
        removeProperty: (key) => styles.delete(key),
      },
    },
    visualViewport,
    viewportWindow,
    enabled: true,
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
  });
  viewportWindow.innerHeight = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  listeners.get('focusin')({ target: { matches: () => true } });
  assert.equal(styles.get('--visual-viewport-height'), '430px');
  assert.equal(styles.get('--visual-viewport-offset-top'), '32px');
  binding.destroy();
});

test('a closing keyboard cannot retain a pan offset beyond the restored layout bounds', () => {
  const styles = new Map();
  const visualViewport = {
    height: 430,
    offsetTop: 32,
    addEventListener() {},
    removeEventListener() {},
  };
  const viewportWindow = { innerHeight: 430, addEventListener() {}, removeEventListener() {} };
  const binding = VisualViewport.bindVisualViewport({
    rootElement: {
      style: {
        setProperty: (key, value) => styles.set(key, value),
        removeProperty: (key) => styles.delete(key),
      },
    },
    visualViewport,
    viewportWindow,
    enabled: true,
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
  });
  viewportWindow.innerHeight = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  assert.equal(styles.get('--visual-viewport-offset-top'), '0px');
  visualViewport.height = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-offset-top'), '0px');
  binding.destroy();
});

test('layout height jitter after keyboard close does not collapse the terminal again', () => {
  const styles = new Map(),
    listeners = new Map();
  const visualViewport = {
    height: 430,
    offsetTop: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  const viewportWindow = {
    innerHeight: 430,
    document: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const binding = VisualViewport.bindVisualViewport({
    rootElement: {
      style: {
        setProperty: (key, value) => styles.set(key, value),
        removeProperty: (key) => styles.delete(key),
      },
    },
    visualViewport,
    viewportWindow,
    enabled: true,
    requestFrame: (callback) => {
      callback();
      return 0;
    },
    cancelFrame() {},
  });
  viewportWindow.innerHeight = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  viewportWindow.innerHeight = 820;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  viewportWindow.innerHeight = 844;
  binding.sync();
  assert.equal(styles.get('--visual-viewport-height'), '844px');
  listeners.get('pointerdown')({ target: { matches: () => true } });
  assert.equal(
    styles.get('--visual-viewport-height'),
    '430px',
    'Tapping the editor may reopen the keyboard',
  );
  binding.destroy();
});
