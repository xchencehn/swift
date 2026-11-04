'use strict';

/**
 * 按来源选择聊天流渲染器。
 *
 * 每个 Harness 拥有自己的渲染器，保留各自的命令、消息、状态和配色特点。
 * 这不是装饰：两家产出的消息种类本来就不同 —— Claude 有 recap 和接口错误两种
 * 记录，Codex 一条都没有。把它们压成一套通用卡片，等于把各家
 * 终端上看得见的东西在网页上抹掉。
 *
 * 🔑 按**消息的实际来源**选，不按会话的默认 Harness。跨 Harness 交接、导入
 * 历史或多种来源并列时，各段要保留自己的渲染方式。也不按模型名或终端标题
 * 猜：那是两码事。
 *
 * 渲染器只负责气泡内部：标记、块、语义配色。顺序、分页、滚动锚点、节点身份
 * 和操作分发归公共容器，渲染器碰不到。
 */
(function (root) {
  const registry = new Map();
  let fallback = null;

  function register(renderer) {
    if (!renderer?.harnessId) throw new Error('渲染器必须声明 harnessId。');
    registry.set(renderer.harnessId, renderer);
    return renderer;
  }

  /** 兜底渲染器：来源未知或某家还没有实现时用它，不能让内容整块消失。 */
  function setFallback(renderer) {
    fallback = renderer;
    return renderer;
  }

  /**
   * 取渲染器。`schemaVersion` 高于渲染器声明支持的版本时仍然返回它，但标记
   * `degraded`：宁可用旧渲染器显示得朴素一些，也不要空白一片；调用方据此
   * 给出明确的兼容提示，不冒充已经完整适配。
   */
  function forHarness(harnessId, schemaVersion = 1) {
    const known = registry.get(String(harnessId || '').toLowerCase());
    const renderer = known || fallback;
    if (!renderer) throw new Error('没有可用的聊天流渲染器。');
    const supported = renderer.schemaVersion ?? 1;
    // 两种降级的原因不同，调用方要能分别说明：没有专用渲染器 vs 数据版本过新。
    // 合成一个布尔值会让提示文案说错话。
    const reason =
      !known && harnessId ? 'no-renderer' : schemaVersion > supported ? 'schema-newer' : null;
    return { renderer, degraded: Boolean(reason), reason };
  }

  const listed = () => [...registry.keys()].sort();

  root.StudioRenderers = {
    register,
    setFallback,
    for: forHarness,
    listed,
    get fallback() {
      return fallback;
    },
  };
})(typeof window === 'undefined' ? globalThis : window);
