/* Images and local output files share the same touch/keyboard context menu. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioImageMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_BYTES = 64 * 1024 * 1024;
  const nativeApp = () => window.StudioApp || null;
  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  function fileName(value, mime) {
    let name =
      String(value || 'file')
        .split(/[\\/]/)
        .pop()
        .replace(/[\x00-\x1f\x7f:*?"<>|]/g, '')
        .replace(/^\.+/, '')
        .trim() || 'file';
    const ext = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
    }[mime];
    if (ext && !/\.[a-z0-9]{1,8}$/i.test(name)) name += ext;
    return name;
  }
  function bind({ selector, openMenu, closeMenu = () => {}, reportError, headers = () => ({}) }) {
    const pending = new Map();
    window.addEventListener('swift.file.saved', (event) => {
      const item = pending.get(event.detail?.id);
      if (!item) return;
      pending.delete(event.detail.id);
      event.detail.error ? item.reject(new Error(event.detail.error)) : item.resolve();
    });
    async function resource(node) {
      const source = node.dataset.downloadUrl || node.currentSrc || node.src;
      if (!source) throw new Error('图片还没加载好，请稍后重试。');
      const response = await fetch(source, {
        headers: source.startsWith('blob:') || source.startsWith('data:') ? {} : headers(),
        credentials: 'same-origin',
      });
      if (!response.ok) {
        let message = '文件无法下载，请重新打开后重试。';
        try {
          message = (await response.json()).message || message;
        } catch {}
        throw new Error(message);
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES)
        throw new Error('文件超过 64 MB，无法在这里保存。');
      const blob = await response.blob();
      if (blob.size > MAX_BYTES) throw new Error('文件超过 64 MB，无法在这里保存。');
      return {
        blob,
        name: fileName(node.dataset.downloadName || node.dataset.path || node.alt, blob.type),
      };
    }
    async function nativeFile(blob, name) {
      const app = nativeApp(),
        id =
          crypto.randomUUID?.() ||
          Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('-');
      if (!app.beginSaveFile(id, name, blob.type || 'application/octet-stream'))
        throw new Error('另一个文件正在保存，请先完成或取消。');
      try {
        for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
          if (!app.appendSaveFile(id, await blobToBase64(blob.slice(offset, offset + 192 * 1024))))
            throw new Error('文件写入失败，请重试。');
        }
        await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          if (!app.finishSaveFile(id)) {
            pending.delete(id);
            reject(new Error('无法打开保存位置选择器。'));
          }
        });
      } catch (error) {
        app.abortSaveFile(id);
        throw error;
      }
    }
    async function save(node) {
      const { blob, name } = await resource(node),
        image = node.tagName === 'IMG';
      if (image && blob.size <= 20 * 1024 * 1024 && nativeApp()?.saveImageResult) {
        const error = nativeApp().saveImageResult(await blobToBase64(blob), name, blob.type);
        if (error) throw new Error(error);
        return;
      }
      if (image && blob.size <= 20 * 1024 * 1024 && nativeApp()?.saveImage) {
        nativeApp().saveImage(await blobToBase64(blob), name, blob.type);
        return;
      }
      if (nativeApp()?.beginSaveFile) {
        await nativeFile(blob, name);
        return;
      }
      if (nativeApp()) {
        throw new Error('请更新 Swift 客户端后再保存文件。');
      }
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    async function share(node) {
      const { blob, name } = await resource(node);
      if (nativeApp()?.shareImage) {
        nativeApp().shareImage(await blobToBase64(blob), name, blob.type);
        return;
      }
      try {
        await navigator.share({ files: [new File([blob], name, { type: blob.type })] });
      } catch (error) {
        if (error?.name !== 'AbortError') throw error;
      }
    }
    const now = () => performance.now();
    let openedAt = -Infinity,
      pressed = null,
      blockClick = null;
    document.addEventListener('click', (event) => {
      const node = event.target.closest?.('[data-save-file]');
      if (!node || node.disabled) return;
      event.preventDefault();
      node.disabled = true;
      const status = node
        .closest('.file-preview, .doc-read-error')
        ?.querySelector('[data-file-save-status]');
      if (status) {
        status.hidden = false;
        status.textContent = '正在保存文件…';
      }
      save(node)
        .then(() => {
          if (status) {
            status.textContent = '';
            status.hidden = true;
          }
        })
        .catch((error) => {
          if (status) {
            status.hidden = false;
            status.textContent = error.message || '保存失败，请重试。';
          } else reportError(error.message || '保存失败，请重试。');
        })
        .finally(() => {
          node.disabled = false;
        });
    });
    function open(node, x, y) {
      if (!node.isConnected || now() - openedAt < 600) return;
      openedAt = now();
      const run = (action) =>
        action(node)
          .then(() => reportError(''))
          .catch((error) => reportError(error.message || '操作失败'));
      const items = [
        {
          id: 'save',
          label: node.tagName === 'IMG' ? '保存到本地' : '下载文件',
          handler: () => run(save),
        },
      ];
      if (
        node.tagName === 'IMG' &&
        (nativeApp()?.shareImage ||
          navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] }))
      )
        items.push({ id: 'share', label: '分享…', handler: () => run(share) });
      openMenu(items, x, y, node.closest('dialog[open]'));
    }
    function target(event) {
      const node = event.target.closest?.(selector);
      return node?.matches('.doc-inline-image, .chat-image')
        ? node.querySelector('img') || node
        : node;
    }
    document.addEventListener(
      'contextmenu',
      (event) => {
        const node = target(event);
        if (!node) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (pressed)
          blockClick = {
            node: node.closest('button,a,.doc-inline-image') || node,
            until: now() + 1200,
          };
        cancel();
        open(node, event.clientX, event.clientY);
      },
      true,
    );
    let timer = 0;
    function cancel() {
      clearTimeout(timer);
      pressed = null;
    }
    document.addEventListener(
      'touchstart',
      (event) => {
        cancel();
        const node = target(event);
        if (!node || event.touches.length !== 1) return;
        const { clientX: x, clientY: y } = event.touches[0];
        pressed = { node, x, y };
        timer = setTimeout(() => {
          if (!pressed) return;
          blockClick = {
            node: node.closest('button,a,.doc-inline-image') || node,
            until: now() + 1200,
          };
          open(node, x, y);
        }, 500);
      },
      { passive: true },
    );
    document.addEventListener(
      'touchmove',
      (event) => {
        if (!pressed) return;
        const t = event.touches[0];
        if (
          event.touches.length !== 1 ||
          !t ||
          Math.hypot(t.clientX - pressed.x, t.clientY - pressed.y) > 10
        )
          cancel();
      },
      { passive: true },
    );
    for (const type of ['touchend', 'touchcancel'])
      document.addEventListener(type, cancel, { passive: true });
    document.addEventListener('scroll', cancel, true);
    document.addEventListener(
      'click',
      (event) => {
        if (
          blockClick &&
          now() < blockClick.until &&
          (event.target === blockClick.node || blockClick.node.contains(event.target))
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          blockClick = null;
        }
      },
      true,
    );
    window.addEventListener('swift.media.close', closeMenu);
  }
  return { bind, fileName };
});
