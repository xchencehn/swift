'use strict';
const { managedCodexBinary } = require('./codex-runtime');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// Read each native tool's installed catalog; no second control channel is started.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function readClaudeCatalog() {
  const dir = path.join(os.homedir(), '.claude', 'cache', 'model-catalog');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('published-') && !name.includes('floor'))
      .map((name) => path.join(dir, name));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const outer = JSON.parse(fs.readFileSync(file, 'utf8'));
      const doc = JSON.parse(Buffer.from(outer.documentBytes, 'base64').toString('utf8'));
      const config = doc?.surfaces?.cc?.model_selector_config;
      const models = Array.isArray(config) ? config[0]?.models : null;
      if (!Array.isArray(models) || !models.length) continue;
      return models.map((model) => ({
        id: model.id,
        label: model.name || model.id,
        short: model.short_name || null,
        // section:main 是选择器里默认露出的那几个,overflow 是折叠区的老型号
        primary: model.section === 'main',
        efforts: (model.thinking?.effort_options || []).map((option) => ({
          id: option.id,
          label: option.name || option.id,
          // badge 上写着 Default 的那一档就是这个模型的默认档位
          isDefault: option.badge?.message === 'Default',
        })),
        effortNote: model.thinking?.description || null,
      }));
    } catch {
      /* 下一份 */
    }
  }
  return null;
}

/** `codex debug models` 的输出 → 目录。拆成纯函数，测试不必真的调 codex。 */
function codexModels(output) {
  const models = JSON.parse(output).models || [];
  return (
    models
      // 内部型号(codex-auto-review、gpt-reserve)不该出现在选择器里。⚠️ 表示它的字段是
      // `visibility: 'hide'`，不是 `hidden` —— 按 `hidden` 过滤等于没过滤，这两个曾经一直
      // 漏在网页的模型列表里（2026-09-23 查出）。与终端 /model 里列出的一致。
      .filter((model) => model.visibility !== 'hide' && !model.hidden)
      .map((model) => ({
        id: model.slug,
        label: model.display_name || model.slug,
        short: null,
        primary: Boolean(model.is_default),
        // ⚠️ 档位**因模型而异**,不是固定枚举 —— 必须逐模型带出去,前端不能写死
        efforts: (model.supported_reasoning_levels || []).map((level) => ({
          id: level.effort,
          label: level.effort,
          note: level.description || null,
          isDefault: level.effort === model.default_reasoning_level,
        })),
        effortNote: null,
        // 速度档位（Fast）。终端里用 /fast 开关，见 lib/codex-settings.js。
        serviceTiers: (model.service_tiers || []).map((tier) => ({
          id: tier.id,
          name: tier.name,
          description: tier.description || '',
        })),
        defaultServiceTier: null,
      }))
  );
}

function readCodexCatalog(timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      managedCodexBinary() || 'codex',
      ['debug', 'models'],
      { timeout: timeoutMs, maxBuffer: 8 << 20 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        try {
          resolve(codexModels(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * provider: 'codex' | 'claude'。拿不到一律返回 `{ models: [] }`,让前端如实说拿不到。
 *
 * 两家都读本机的目录：Codex 是 `codex debug models`，Claude 是它的缓存。原来 Codex 优先问
 * app-server，2026-09-23 全面改走 PTY 后那条通道已经拆掉。
 */
async function readAgentCatalog(provider) {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    let models = null;
    if (provider === 'claude') models = readClaudeCatalog();
    else if (provider === 'codex') models = await readCodexCatalog();
    return { provider, models: models || [], source: models ? 'local-cache' : 'unavailable' };
  })();
  cache.set(provider, { at: Date.now(), promise });
  return promise;
}

module.exports = { readAgentCatalog, codexModels };
