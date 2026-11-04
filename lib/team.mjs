// Команда агентов: одна задача — несколько агентов по ролям, по очереди в одной папке.
// Ведущий (обычно Claude) составляет план в режиме «только чтение», дальше шаги исполняют агенты своих ролей;
// между шагами Depo передаёт контекст (handoff), тест-шаг может вернуть работу исполнителю.
// Здесь — чистая логика: настройки, план, задания для шагов, вердикт тестов. Запуск — в server.mjs.

const KEY = 'team';
export const PROVIDERS = ['claude', 'codex', 'kimi'];

export const DEFAULT = {
  default_on: false,            // включать команду в новых чатах
  approve: true,                // показывать план до запуска
  fallback: true,               // лимит агента > 90% — шаг берёт другой
  retries: 2,                   // сколько раз возвращать исполнителю после упавших тестов
  max_steps: 8,
  off: [],                      // выключенные из команды агенты — их роли берут оставшиеся
  roles: [
    { id: 'lead', name: 'Ведущий · план и сложное', desc: 'разбирает задачу на шаги, пишет ядро и сложную логику, делает финальное ревью',
      keywords: ['архитектура', 'бэкенд', 'сервер', 'api', 'база', 'баг', 'ошибк', 'логик', 'ревью', 'рефактор'], provider: 'claude', model: '', effort: '' },
    { id: 'ui', name: 'Визуал и интерфейс', desc: 'вёрстка, стили, анимации, адаптив под телефон, внешний вид',
      keywords: ['визуал', 'дизайн', 'css', 'стил', 'вёрстк', 'верстк', 'анимац', 'интерфейс', 'кнопк', 'мобильн', 'цвет', 'шрифт', 'иконк', 'экран'], provider: 'codex', model: '', effort: '' },
    { id: 'test', name: 'Обкатка и тесты', desc: 'пишет и гоняет тесты, проверяет сценарии, ищет регрессии',
      keywords: ['тест', 'проверк', 'обкат', 'регресс', 'e2e', 'сломал'], provider: 'kimi', model: '', effort: '' },
  ],
};

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const slug = s => clean(s).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 24) || 'role';

export function normalize(cfg = {}) {
  const roles = (Array.isArray(cfg.roles) && cfg.roles.length ? cfg.roles : DEFAULT.roles).slice(0, 8).map((r, i) => ({
    id: /^[\w-]{1,24}$/.test(r.id || '') ? r.id : slug(r.name) + '-' + i,
    name: clean(r.name).slice(0, 60) || 'Роль',
    desc: clean(r.desc).slice(0, 240),
    keywords: (Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(','))
      .map(k => clean(k).toLowerCase()).filter(Boolean).slice(0, 20),
    provider: PROVIDERS.includes(r.provider) ? r.provider : 'claude',
    model: clean(r.model).slice(0, 80),
    effort: clean(r.effort).slice(0, 20),
    instructions: String(r.instructions ?? '').replace(/\r/g, '').trim().slice(0, 2000),   // свои указания роли — как подстройка агента в отдельном чате
  }));
  if (!roles.some(r => r.id === 'lead')) roles[0].id = 'lead';   // ведущий нужен всегда: он планирует и подводит итог
  let off = [...new Set(Array.isArray(cfg.off) ? cfg.off : [])].filter(p => PROVIDERS.includes(p));
  if (PROVIDERS.every(p => off.includes(p))) off = [];   // все выключены — так работать нельзя, считаем, что выключенных нет
  return {
    default_on: !!cfg.default_on,
    approve: cfg.approve === undefined ? DEFAULT.approve : !!cfg.approve,
    fallback: cfg.fallback === undefined ? DEFAULT.fallback : !!cfg.fallback,
    retries: Math.max(0, Math.min(3, Number.isFinite(+cfg.retries) ? +cfg.retries : DEFAULT.retries)),
    max_steps: Math.max(2, Math.min(12, +cfg.max_steps || DEFAULT.max_steps)),
    off,
    roles,
  };
}
export function config(h) { let v = {}; try { v = JSON.parse(h.setting(KEY) || '{}'); } catch { } return normalize(v); }
export function save(h, cfg) {
  if (Array.isArray(cfg?.off) && PROVIDERS.every(p => cfg.off.includes(p))) throw new Error('Нельзя выключить всех агентов команды — оставь хотя бы одного.');
  const v = normalize(cfg); h.setting(KEY, JSON.stringify(v)); return v; }
export const role = (cfg, id) => cfg.roles.find(r => r.id === id) ?? cfg.roles.find(r => r.id === 'lead');

// Подсказка: какая роль больше подходит под текст задачи (по ключевым словам).
export function suggest(cfg, text) {
  const t = String(text || '').toLowerCase();
  let best = null, score = 0;
  for (const r of cfg.roles) {
    const s = r.keywords.reduce((n, k) => n + (k && t.includes(k) ? 1 : 0), 0);
    if (s > score || (s && s === score && best?.id === 'lead')) { best = r; score = s; }   // при равенстве — узкая роль, а не ведущий
  }
  return best ? { role: best.id, name: best.name, provider: best.provider, score } : null;
}

// Свои указания владельца для роли — отдельным блоком в задании агента
const notes = r => r?.instructions ? `\n\nУказания владельца для роли «${r.name}»:\n${r.instructions}\n` : '';

// Кто фактически выполняет роль. Агент роли выключен из команды (или без входа — ready) — роль берёт
// другой включённый: сначала агент другой не-ведущей роли, потом агент ведущего, потом любой включённый.
// Модель и раздумья — от роли подменяющего агента; указания (instructions) остаются за ролью.
// reason: 'off' — выключен владельцем, 'ready' — нет входа. null — выполнять некому.
export function assignee(cfg, r, ready = () => true) {
  const ok = p => !cfg.off?.includes(p) && ready(p);
  if (ok(r.provider)) return { provider: r.provider, model: r.model, effort: r.effort, instead: null, reason: null };
  const reason = cfg.off?.includes(r.provider) ? 'off' : 'ready';
  const lead = role(cfg, 'lead');
  const sub = [...cfg.roles.filter(x => x !== r && x.id !== 'lead'), lead].find(x => x && ok(x.provider));
  if (sub) return { provider: sub.provider, model: sub.model, effort: sub.effort, instead: r.provider, reason };
  const any = PROVIDERS.find(ok);
  return any ? { provider: any, model: '', effort: '', instead: r.provider, reason } : null;
}

export const NAMES = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code' };
const rolesList = cfg => cfg.roles.map(r => {
  const a = assignee(cfg, r);
  const who = !a ? 'агент не назначен' : a.instead ? `агент ${NAMES[a.provider]}, вместо ${NAMES[a.instead]} — он выключен из команды` : `агент ${NAMES[a.provider]}`;
  return `- ${r.id}: ${r.name} — ${r.desc || 'без описания'} (${who})`;
}).join('\n');

export function planPrompt(cfg, task) {
  return `Ты — ведущий команды агентов в Depo. Владелец дал задачу, её выполнят несколько агентов ПО ОЧЕРЕДИ в этой папке проекта.
Сейчас ты только ПЛАНИРУЕШЬ: можешь читать код и файлы, но ничего не меняй.

Роли команды:
${rolesList(cfg)}

Задача владельца:
${task}
${notes(role(cfg, 'lead'))}
Составь план из 1–${cfg.max_steps} шагов. Правила:
- каждый шаг — одной роли (поле role — id роли из списка выше); бери роль по сути работы;
- простая задача — смело 1–2 шага, не раздувай;
- шаги с изменениями — раньше, проверка/тесты — после них;
- последний шаг — роль lead: ревью сделанного и короткий итог для владельца;
- в поле do — конкретно, что сделать на шаге: файлы, критерии готовности.

Ответь по-русски: одна-две фразы о подходе, затем блок:
\`\`\`json
{"steps":[{"role":"lead","title":"короткое название шага","do":"что именно сделать"}]}
\`\`\``;
}

export function parsePlan(text, cfg) {
  const s = String(text || '');
  const m = s.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || s.match(/(\{[\s\S]*"steps"[\s\S]*\})/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[1]); } catch { return null; }
  const steps = (Array.isArray(j.steps) ? j.steps : []).map(x => ({
    role: cfg.roles.some(r => r.id === x?.role) ? x.role : 'lead',
    title: clean(x?.title).slice(0, 140) || 'Шаг',
    do: String(x?.do ?? x?.task ?? '').trim().slice(0, 2000),
  })).filter(x => x.title).slice(0, cfg.max_steps);
  if (!steps.length) return null;
  if (steps.at(-1).role !== 'lead' && steps.length < cfg.max_steps)
    steps.push({ role: 'lead', title: 'Ревью и итог', do: 'Проверь, что сделано по плану, и коротко подведи итог для владельца.' });
  return steps.map(x => ({ ...x, status: 'wait' }));
}

const isTest = (cfg, roleId) => /тест|обкат|провер|qa|test/i.test(`${roleId} ${role(cfg, roleId)?.name}`);

export function stepPrompt(cfg, { task, steps, i }) {
  const st = steps[i], r = role(cfg, st.role);
  const plan = steps.map((x, k) => `${k + 1}. ${k < i ? '✓' : k === i ? '→' : ' '} [${role(cfg, x.role)?.name}] ${x.title}`).join('\n');
  return `Ты работаешь в команде агентов Depo. Твоя роль: «${r.name}» — ${r.desc || ''}.
Общая задача владельца:
${task}

План команды:
${plan}

Твой шаг ${i + 1} из ${steps.length}: ${st.title}
${st.do}${notes(r)}

Сделай только свой шаг — чужие шаги сделают другие агенты. В конце коротко: что сделал и какие файлы изменил.` +
    (isTest(cfg, st.role) ? `\nПоследней строкой ОБЯЗАТЕЛЬНО напиши «ИТОГ: ПРОЙДЕНО» или «ИТОГ: ПРОВАЛЕНО» (если провалено — выше перечисли, что именно упало).` : '') +
    (isFinalReview(steps, i) ? `\nВ самом конце добавь блок «УРОКИ:» — 0–3 строки-пункта о том, что стоит помнить в этом проекте дальше (команды проверки, грабли, решения владельца). Только то, что пригодится в следующих задачах; нечего записать — «УРОКИ: нет». Depo сохранит их в .depo/memory/LESSONS.md, их увидят все агенты.` : '');
}
// Финальное ревью: последний шаг плана за ведущим — он и записывает уроки задачи
export const isFinalReview = (steps, i) => i === steps.length - 1 && steps[i]?.role === 'lead';


// Вердикт тест-шага: true — прошло, false — упало, null — непонятно (считаем прошедшим, но без уверенности)
export function verdict(text) {
  const m = String(text || '').match(/ИТОГ:\s*(ПРОЙДЕНО|ПРОВАЛЕНО)/i);
  return m ? m[1].toUpperCase() === 'ПРОЙДЕНО' : null;
}
export const testStep = isTest;

// Упали тесты: вставляем «исправить» для последнего исполнителя и повторную проверку.
export function withFix(cfg, steps, i, report) {
  const prevWork = [...steps.slice(0, i)].reverse().find(x => !isTest(cfg, x.role) && x.role !== 'lead') ?? steps.slice(0, i).reverse().find(x => !isTest(cfg, x.role)) ?? { role: 'lead' };
  const fix = { role: prevWork.role, title: 'Исправить по итогам проверки', do: `Проверка нашла проблемы — исправь их:\n${String(report || '').slice(-1500)}`, status: 'wait', fix: true };
  const retest = { ...steps[i], status: 'wait', started_at: null, ended_at: null, run_id: null };
  return [...steps.slice(0, i + 1), fix, retest, ...steps.slice(i + 1)];
}
