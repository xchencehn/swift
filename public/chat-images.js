(function (root) {
  'use strict';
  function createRenderer({ host, urlFor, headers, preserveScroll }) {
    const cache = new Map();
    let generation = 0,
      totalBytes = 0,
      sessionKey,
      cards = new Map(),
      previousCards = new Map(),
      occurrences = new Map();
    const viewer = document.createElement('dialog');
    viewer.className = 'chat-image-viewer';
    viewer.setAttribute('aria-label', '图片预览');
    const large = document.createElement('img');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭图片');
    viewer.append(large, close);
    document.body.append(viewer);
    close.onclick = () => viewer.close();
    viewer.onclick = (event) => {
      if (event.target === viewer) viewer.close();
    };
    viewer.addEventListener('close', () => {
      large.removeAttribute('src');
      window.dispatchEvent(new Event('swift.media.close'));
    });
    const observer =
      'IntersectionObserver' in root
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.isIntersecting) {
                  observer.unobserve(entry.target);
                  entry.target.loadImage();
                }
            },
            { root: host, rootMargin: '400px 0px' },
          )
        : null;
    async function load(url) {
      if (cache.has(url)) {
        const value = cache.get(url);
        cache.delete(url);
        cache.set(url, value);
        return value.promise;
      }
      const entry = { size: 0 };
      entry.promise = (async () => {
        const response = await fetch(url, { headers: headers(), credentials: 'same-origin' });
        if (!response.ok) throw Error('图片无法加载');
        const blob = await response.blob();
        if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type) || blob.size > 20 * 1024 * 1024)
          throw Error('图片格式不支持');
        entry.size = blob.size;
        entry.url = URL.createObjectURL(blob);
        totalBytes += entry.size;
        while ((totalBytes > 48 * 1024 * 1024 || cache.size > 32) && cache.size > 1) {
          const oldKey = [...cache.keys()].find((key) => key !== url && cache.get(key).url);
          if (!oldKey) break;
          const old = cache.get(oldKey);
          URL.revokeObjectURL(old.url);
          totalBytes -= old.size;
          cache.delete(oldKey);
        }
        return entry.url;
      })().catch((error) => {
        cache.delete(url);
        throw error;
      });
      cache.set(url, entry);
      return entry.promise;
    }
    function reset(key) {
      generation++;
      observer?.disconnect();
      occurrences = new Map();
      previousCards = key === sessionKey ? cards : new Map();
      cards = new Map();
      if (key !== sessionKey && viewer.open) viewer.close();
      sessionKey = key;
    }
    function render(block, target) {
      const url = urlFor(block, target),
        occurrence = occurrences.get(url) || 0;
      occurrences.set(url, occurrence + 1);
      const key = `${url}:${target.slot}:${occurrence}`;
      const previous = previousCards.get(key);
      if (previous) {
        previous.imageGeneration = generation;
        cards.set(key, previous);
        if (!previous.classList.contains('loaded'))
          observer ? observer.observe(previous) : queueMicrotask(previous.loadImage);
        return previous;
      }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'chat-image';
      card.imageGeneration = generation;
      cards.set(key, card);
      card.dataset.imageId = block.id;
      card.setAttribute('aria-label', `放大图片：${block.alt || '图片'}`);
      const img = document.createElement('img');
      img.alt = block.alt || '图片';
      img.decoding = 'async';
      img.dataset.downloadName = block.alt || 'image';
      img.dataset.downloadUrl = url;
      const notice = document.createElement('span');
      notice.className = 'chat-image-notice';
      notice.textContent = '加载图片…';
      const ratio = block.width > 0 && block.height > 0 ? block.width / block.height : 1;
      // 比例交给 CSS 变量,卡片的宽高上限都按它换算,卡片因此和图片严丝合缝。
      card.style.setProperty('--chat-image-ratio', String(ratio));
      if (block.width && block.height) {
        img.width = block.width;
        img.height = block.height;
      }
      card.append(img, notice);
      let ready = false,
        loading = false;
      const valid = () => card.imageGeneration === generation && card.isConnected;
      card.loadImage = async () => {
        if (loading || ready || !url) return;
        loading = true;
        notice.textContent = '加载图片…';
        card.classList.remove('failed');
        try {
          const source = await load(url);
          if (!valid()) return;
          img.onload = async () => {
            try {
              await img.decode();
            } catch {
              img.onerror();
              return;
            }
            if (!valid()) return;
            preserveScroll(() => {
              card.style.setProperty(
                '--chat-image-ratio',
                String(img.naturalWidth / img.naturalHeight),
              );
              card.classList.add('loaded');
              notice.hidden = true;
            });
            ready = true;
            loading = false;
          };
          img.onerror = () => {
            const old = cache.get(url);
            if (old?.url) {
              URL.revokeObjectURL(old.url);
              totalBytes -= old.size;
              cache.delete(url);
            }
            ready = false;
            loading = false;
            card.classList.add('failed');
            notice.hidden = false;
            notice.textContent = '图片无法加载，点击重试';
          };
          img.src = source;
        } catch {
          if (valid()) {
            card.classList.add('failed');
            notice.textContent = '图片无法加载，点击重试';
          }
          loading = false;
        }
      };
      card.onclick = async () => {
        if (!ready) {
          card.loadImage();
          return;
        }
        try {
          const source = await load(url);
          if (!valid()) return;
          large.src = source;
          large.alt = img.alt;
          large.dataset.downloadName = img.dataset.downloadName;
          large.dataset.downloadUrl = img.dataset.downloadUrl;
          viewer.showModal();
        } catch {
          notice.hidden = false;
          notice.textContent = '图片无法加载，点击重试';
          ready = false;
        }
      };
      if (observer) observer.observe(card);
      else queueMicrotask(card.loadImage);
      return card;
    }
    function closePreview() {
      if (!viewer.open) return false;
      viewer.close();
      return true;
    }
    return { render, reset, closePreview };
  }
  root.StudioChatImages = { createRenderer };
})(window);
