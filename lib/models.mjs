import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { kimiEnv } from './accounts.mjs';

const RU = {
  'For complex work and everyday tasks': 'Для сложной и повседневной работы',
  'Most efficient for simpler tasks': 'Самая экономная для простых задач',
  'For your toughest challenges': 'Для самых трудных задач',
  'Fastest for quick answers': 'Самая быстрая для коротких ответов',
};

function claudeCatalog() {
  const dir = path.join(os.homedir(), '.claude', 'cache', 'model-catalog');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('published-') && f !== 'published-floor.json'); } catch { }
  for (const f of files) {
    try {
      const wrap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const doc = JSON.parse(Buffer.from(wrap.documentBytes, 'base64').toString('utf8'));
      const cfg = doc.surfaces?.cc?.model_selector_config?.[0];
      const state = doc.surfaces?.cc?.model_selector_state?.[0];
      if (!cfg?.models?.length) continue;
      const main = cfg.models.filter(m => m.section === 'main');
      const more = cfg.models.filter(m => m.section !== 'main');
      const effortOf = id => state?.thinking_by_model?.find(x => x.id === id)?.thinking?.effort ?? null;
      return {
        source: 'catalog', version: doc.version, defaultModel: state?.model ?? null,
        items: [
          { id: '', name: 'По умолчанию', description: `Как в Claude Code: ${nameOf(cfg.models, state?.model) || 'текущая модель подписки'}`, section: 'main', recommended: true, efforts: CLAUDE_EFFORTS },
          ...main.map(m => ({ id: m.id, name: m.name, description: RU[m.description] ?? m.description ?? '', section: 'main', effort: effortOf(m.id), efforts: CLAUDE_EFFORTS })),
          ...more.map(m => ({ id: m.id, name: m.name, description: '', section: 'more', effort: effortOf(m.id), efforts: CLAUDE_EFFORTS })),
        ],
      };
    } catch { }
  }
  return {
    source: 'fallback', defaultModel: null,
    items: [
      { id: '', name: 'По умолчанию', description: 'Как в Claude Code', section: 'main', recommended: true },
      { id: 'opus', name: 'Opus', section: 'main', efforts: CLAUDE_EFFORTS }, { id: 'sonnet', name: 'Sonnet', section: 'main', efforts: CLAUDE_EFFORTS }, { id: 'haiku', name: 'Haiku', section: 'main', efforts: CLAUDE_EFFORTS },
    ],
  };
}
const nameOf = (models, id) => models.find(m => m.id === id)?.name;

function codexCatalog() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const list = Array.isArray(d) ? d : (d.models ?? Object.values(d));
    const items = list.filter(m => m && (m.slug || m.id) && !/auto-review/.test(m.slug || m.id))
      .map((m, i) => ({
        id: m.slug || m.id, name: m.display_name || m.displayName || m.slug || m.id,
        description: m.description || '', section: i < 4 ? 'main' : 'more',
        effort: m.default_reasoning_level ?? null,
        efforts: (m.supported_reasoning_levels ?? []).map(e => ({ id: e.effort, name: EFFORT_RU[e.effort]?.name ?? e.effort, hint: EFFORT_RU[e.effort]?.hint ?? e.description ?? '' })),
      }));
    const common = items[0]?.efforts?.length ? items[0].efforts : [];
    return { source: 'cache', items: [{ id: '', name: 'По умолчанию', description: 'Как в Codex (из config.toml)', section: 'main', recommended: true, efforts: common }, ...items] };
  } catch {
    return { source: 'fallback', items: [{ id: '', name: 'По умолчанию', section: 'main', recommended: true }, { id: 'gpt-5-codex', name: 'gpt-5-codex', section: 'main' }] };
  }
}

const EFFORT_RU = {
  low: { name: 'Быстро', hint: 'меньше раздумий, быстрый ответ' },
  medium: { name: 'Обычно', hint: 'баланс скорости и глубины' },
  high: { name: 'Вдумчиво', hint: 'больше раздумий на сложных задачах' },
  xhigh: { name: 'Глубоко', hint: 'ещё больше раздумий, заметно дольше' },
  max: { name: 'Максимум', hint: 'предел для самых трудных задач' },
  ultra: { name: 'Предельно', hint: 'максимум плюс автоматическое дробление задачи' },
};
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  .map(id => ({ id, name: EFFORT_RU[id].name, hint: EFFORT_RU[id].hint }));

export const PERMISSION_MODES = [
  { id: 'manual', name: 'По умолчанию', hint: 'спрашивает перед командами и правками вне разрешённого' },
  { id: 'acceptEdits', name: 'Принимать правки', hint: 'правки файлов сразу, команды — с вопросом' },
  { id: 'plan', name: 'Режим плана', hint: 'только читает и планирует, ничего не меняет' },
  { id: 'auto', name: 'Авто', hint: 'сам решает, когда спросить' },
  { id: 'dontAsk', name: 'Не спрашивать', hint: 'что не разрешено заранее — отклоняется молча' },
  { id: 'bypassPermissions', name: 'Без проверок', hint: 'пропускает все проверки — только для своей песочницы' },
];
export const EFFORTS = CLAUDE_EFFORTS;

const KIMI_FALLBACK = {
  source: 'fallback', defaultModel: null,
  items: [{ id: '', name: 'По умолчанию', description: 'Модель из настроек Kimi Code', section: 'main', recommended: true }],
};
const contextSize = n => n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : '';

export function parseKimiCatalog(raw, defaultAlias = '') {
  const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const items = Object.entries(d?.models ?? {}).map(([alias, m]) => {
    const efforts = (m.supportEfforts ?? m.support_efforts ?? []).map(id => ({ id, name: EFFORT_RU[id]?.name ?? id, hint: EFFORT_RU[id]?.hint ?? '' }));
    return {
      id: alias, name: m.displayName || m.display_name || m.model || alias,
      description: m.maxContextSize || m.max_context_size ? `Контекст ${contextSize(m.maxContextSize ?? m.max_context_size)}` : '',
      contextWindow: m.maxContextSize ?? m.max_context_size ?? 0,
      effort: m.defaultEffort ?? m.default_effort ?? null, efforts,
      section: 'main',
    };
  });
  if (!items.length) throw new Error('Kimi Code вернул пустой каталог моделей.');
  const def = items.find(m => m.id === defaultAlias) ?? items[0];
  return {
    source: 'kimi-code', defaultModel: defaultAlias || null,
    items: [{
      id: '', name: 'По умолчанию', description: `Как в Kimi Code: ${def.name}`, section: 'main', recommended: true,
      contextWindow: def.contextWindow, effort: def.effort, efforts: def.efforts,
    }, ...items],
  };
}

function defaultKimiModel() {
  try {
    const root = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const text = fs.readFileSync(path.join(root, 'config.toml'), 'utf8');
    return text.match(/^default_model\s*=\s*["']([^"']+)["']/m)?.[1] ?? '';
  } catch { return ''; }
}

let kimiCache = { at: 0, data: null, busy: false };
export function refreshKimiCatalog() {
  if (kimiCache.busy) return Promise.resolve(kimiCache.data ?? KIMI_FALLBACK);
  kimiCache.busy = true;
  return new Promise(resolve => {
    execFile('kimi', ['provider', 'list', '--json'], { env: kimiEnv(process.env), timeout: 20000, maxBuffer: 8 << 20 }, (err, stdout) => {
      try { if (!err) kimiCache.data = parseKimiCatalog(stdout, defaultKimiModel()); } catch { }
      kimiCache.at = Date.now(); kimiCache.busy = false;
      resolve(kimiCache.data ?? KIMI_FALLBACK);
    });
  });
}
export const kimiCatalog = () => {
  if (Date.now() - kimiCache.at > 300000) refreshKimiCatalog().catch(() => { });
  return kimiCache.data ?? KIMI_FALLBACK;
};

let cache = { at: 0, data: null };
export function catalog() {
  if (Date.now() - cache.at < 300000 && cache.data) return cache.data;
  cache = { at: Date.now(), data: { claude: claudeCatalog(), codex: codexCatalog(), permissions: PERMISSION_MODES, efforts: EFFORTS } };
  return cache.data;
}
