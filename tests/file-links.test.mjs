import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFileUrl, isImagePath } from '../public/file-links.js';

const project = { id: 7, path: '/home/test/project' };
const url = rel => `/api/projects/7/raw?path=${encodeURIComponent(rel)}`;

test('ссылки на файлы принимают относительные и абсолютные пути внутри проекта', () => {
  assert.equal(projectFileUrl(project, '.depo/screens/result.png'), url('.depo/screens/result.png'));
  assert.equal(projectFileUrl(project, './files/report.zip'), url('files/report.zip'));
  assert.equal(projectFileUrl(project, '/home/test/project/.depo/screens/result.png'), url('.depo/screens/result.png'));
  assert.equal(projectFileUrl(project, '<не путь>'), null);
});

test('имена файлов с пробелами и кириллицей кодируются в URL', () => {
  assert.equal(projectFileUrl(project, 'files/новый экран 1.png'), url('files/новый экран 1.png'));
});

test('ссылки не выпускают за пределы проекта и не принимают внешние протоколы', () => {
  assert.equal(projectFileUrl(project, '../secret.txt'), null);
  assert.equal(projectFileUrl(project, 'files/../../secret.txt'), null);
  assert.equal(projectFileUrl(project, '/etc/passwd'), null);
  assert.equal(projectFileUrl(project, '/home/test/project-other/file.txt'), null);
  assert.equal(projectFileUrl(project, 'https://example.com/a.png'), null);
  assert.equal(projectFileUrl(project, 'javascript:alert(1)'), null);
});

test('изображения отличаются от файлов для скачивания', () => {
  assert.ok(isImagePath('screen.PNG'));
  assert.ok(isImagePath('photo.jpg'));
  assert.ok(isImagePath('vector.svg'));
  assert.equal(isImagePath('archive.zip'), false);
  assert.equal(isImagePath('document.pdf'), false);
});
