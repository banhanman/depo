import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open, helpers } from '../lib/db.mjs';
import { createUser, setPassword } from '../lib/auth.mjs';
import { glyphFor } from '../lib/projects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const login = arg('--login') || process.env.DEPO_LOGIN || os.userInfo().username;
const password = arg('--password') || process.env.DEPO_PASSWORD;
const port = arg('--port') || process.env.PORT || '4620';
if (!login || !password) {
  console.error('Укажите логин и пароль через DEPO_LOGIN и DEPO_PASSWORD.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Пароль должен содержать не менее 8 символов.');
  process.exit(1);
}

const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath,
    `HOST=0.0.0.0\nPORT=${port}\nDEPO_DATA_DIR=${path.join(ROOT, 'data')}\nDEPO_BACKUP_DIR=${path.join(os.homedir(), 'backups', 'depo')}\n`,
    { mode: 0o600 });
  console.log('Файл .env создан.');
} else {
  console.log('Файл .env уже существует и не изменён.');
}

const h = helpers(open(path.join(ROOT, 'data')));
const existing = h.get('SELECT * FROM users WHERE login=?', login);
if (existing) {
  setPassword(h, existing.id, password);
  console.log(`Пароль пользователя ${login} обновлён.`);
} else {
  createUser(h, login, password);
  console.log(`Пользователь ${login} создан.`);
}

if (!h.get('SELECT id FROM projects WHERE path=?', ROOT)) {
  const taken = h.all('SELECT glyph FROM projects').map(row => row.glyph);
  const position = h.all('SELECT glyph FROM projects').length + 1;
  h.run('INSERT INTO projects(name,path,glyph,position,created_at) VALUES(?,?,?,?,?)',
    'Depo', ROOT, glyphFor('Depo', taken), position, Date.now());
}

console.log('Настройка завершена.');
