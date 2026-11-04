// Прокликивает весь интерфейс и ловит ошибки в консоли браузера.
// Запуск: DEPO_TOKEN=<кука depo_session> node scripts/ui-check.mjs
// Нужен playwright-core (npm i -D playwright-core) и chromium; путь к браузеру — CHROMIUM_PATH.
const { default: pkg } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const { chromium } = pkg;
const BASE = process.env.DEPO_URL || 'http://127.0.0.1:4620';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const VP = { desk: { width: 1440, height: 900 }, tab: { width: 820, height: 1180 }, mob: { width: 390, height: 844 } }[process.env.VIEWPORT || 'desk'];
const ctx = await b.newContext({ viewport: VP });
await ctx.addCookies([{ name: 'depo_session', value: process.env.DEPO_TOKEN, domain: '127.0.0.1', path: '/' }]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 120)); });
await p.goto(BASE, { waitUntil: 'networkidle' });

const steps = [
  ['выбрать проект', '.pbtn[data-p]'],
  ['открыть чат', '.crow[data-c]'],
  ['показатели', '#chip-gauge'],
  ['закрыть поповер', 'body'],
  ['файлы', '#chip-files'],
  ['вкладка git', '.ftabs button[data-t="diff"]'],
  ['закрыть файлы', '.modal [data-no]'],
  ['второй чат рядом', '#chip-split'],
  ['закрыть второй', '#p2-close'],
  ['меню модели', '#btn-model'],
  ['закрыть меню', 'body'],
  ['меню скорости', '#btn-effort'],
  ['закрыть меню 2', 'body'],
  ['меню разрешений', '#btn-perm'],
  ['закрыть меню 3', 'body'],
  ['меню чата', '.crow .more'],
  ['закрыть меню 4', 'body'],
  ['меню проекта', '#btn-pmenu'],
  ['закрыть меню 5', 'body'],
  ['доска', '#btn-board'],
  ['закрыть доску', '.modal [data-no]'],
  ['настройки', '#btn-settings'],
  ['закрыть настройки', '.modal [data-no]'],
  ['новый проект', '#btn-newproject'],
  ['отмена проекта', '.modal [data-no]'],
  ['пользователь', '#btn-user'],
  ['закрыть меню 6', 'body'],
  ['новый чат', '#btn-newchat'],
  ['свернуть панель', '#btn-side'],
  ['развернуть', '#btn-exp'],
  ['микрофон', '#btn-mic'],
];
let skipped = 0;
// transform уводит панель за экран, но isVisible этого не видит — смотрим реальные координаты
const onScreen = async el => {
  const b = await el.boundingBox().catch(() => null);
  return !!b && b.x + b.width > 2 && b.x < VP.width - 2 && b.y + b.height > 2 && b.y < VP.height - 2;
};
const drawerOpen = () => p.evaluate(() => innerWidth <= 760 && document.getElementById('app').dataset.side === '1');
const setDrawer = async want => {
  if (VP.width > 760 || (await drawerOpen()) === want) return;
  if (want) await p.click('#btn-exp', { timeout: 1500 }).catch(() => { });
  else await p.mouse.click(VP.width - 8, VP.height / 2);   // тап мимо панели закрывает её
  await p.waitForTimeout(400);
};
for (const [name, sel] of steps) {
  try {
    const el = p.locator(sel).first();
    if (!(await el.isVisible().catch(() => false))) { skipped++; continue; }     // display:none на этом вьюпорте
    if (!(await onScreen(el))) {
      await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => { });       // может просто ниже сгиба
      if (!(await onScreen(el))) {
        await setDrawer(true);                                                   // или в выдвижной панели
        if (!(await onScreen(el))) { await setDrawer(false); skipped++; continue; }
      }
    } else if (await drawerOpen()) {
      const inDrawer = await el.evaluate(n => !!n.closest('.side,.rail')).catch(() => false);
      const modalUp = await p.locator('.scrim').first().isVisible().catch(() => false);
      if (!inDrawer && !modalUp) await setDrawer(false);                         // цель в основной области под панелью
    }
    await el.click({ timeout: 3000 }); await p.waitForTimeout(350);
  } catch (e) { errs.push(`КЛИК «${name}» (${sel}): ${e.message.split('\n')[0]}`); }
}
await p.waitForTimeout(800);
console.log(errs.length ? errs.join('\n') : `✅ ${steps.length} действий без ошибок` + (skipped ? ` (пропущено скрытых на этом вьюпорте: ${skipped})` : ''));
process.exitCode = errs.length ? 1 : 0;
await b.close();
