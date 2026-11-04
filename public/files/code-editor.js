(function (root) {
  'use strict';
  let loading = null;
  async function create(options) {
    if (!loading)
      loading = import(new URL(root.StudioCodeEditorAsset, document.baseURI).href).catch(
        (error) => {
          loading = null;
          throw new Error('代码编辑器加载失败，请刷新文件后重试。', { cause: error });
        },
      );
    const module = await loading;
    if (options.current && !options.current()) return null;
    return module.create(options);
  }
  root.StudioFileCodeEditor = { create };
})(globalThis);
