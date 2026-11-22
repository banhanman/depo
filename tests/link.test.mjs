import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linker, CMD } from '../lib/link.mjs';

const wait = (fn, ms = 7000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => fn() ? res() : Date.now() - t0 > ms ? rej(new Error('не дождались')) : setTimeout(tick, 60);
  tick();
});

test('вход идёт через псевдотерминал: виден вопрос CLI и принят ответ', async () => {
  CMD.проба = ['bash', '-c', 'read -p "Вставь код: " c; echo "принят:$c"'];
  const L = new Linker();
  const st = L.start('проба');
  assert.equal(st.status, 'running');
  await wait(() => L.state('проба').text.includes('Вставь код:'));
  L.send('проба', 'abc123');
  await wait(() => L.state('проба').text.includes('принят:abc123'));
  await wait(() => L.state('проба').status === 'done');
});

test('ссылка из вывода подхватывается для браузера', async () => {
  CMD.ссылка = ['bash', '-c', 'echo "Открой https://claude.ai/oauth/authorize?code=true и вставь код"; sleep 0.2'];
  const L = new Linker();
  L.start('ссылка');
  await wait(() => L.state('ссылка').links.length > 0);
  assert.match(L.state('ссылка').links[0], /^https:\/\/claude\.ai\/oauth/);
});

test('без запущенного входа ответ отправить нельзя', () => {
  const L = new Linker();
  assert.throws(() => L.send('claude', 'код'), /не запущен/i);
});
