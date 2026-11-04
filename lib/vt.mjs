// Крошечный экран терминала.
//
// Claude, Codex и Gemini при входе рисуют не строчки, а полноэкранный интерфейс: курсор прыгает,
// экран перерисовывается целиком. Если просто склеивать вывод, в браузере копится простыня из
// десятков одинаковых кадров — именно это и выглядело «некрасиво».
//
// Поэтому ведём у себя маленький буфер экрана и применяем к нему управляющие последовательности,
// как настоящий терминал. Наружу отдаём то, что сейчас на экране. Цвета и прочее оформление
// выбрасываем: в окне входа нужен текст, а не раскраска.
const BLANK = ' ';

export class Screen {
  constructor(cols = 100, rows = 34) {
    this.cols = cols; this.rows = rows;
    this.clear();
  }

  clear() {
    this.buf = Array.from({ length: this.rows }, () => Array(this.cols).fill(BLANK));
    this.x = 0; this.y = 0;
  }

  line(y) { return this.buf[y] ?? (this.buf[y] = Array(this.cols).fill(BLANK)); }

  put(ch) {
    if (this.x >= this.cols) { this.x = 0; this.down(); }
    this.line(this.y)[this.x++] = ch;
  }

  down() {
    this.y++;
    if (this.y >= this.rows) { this.buf.shift(); this.buf.push(Array(this.cols).fill(BLANK)); this.y = this.rows - 1; }
  }

  eraseLine(mode) {
    const l = this.line(this.y);
    const from = mode === 1 ? 0 : this.x;
    const to = mode === 1 ? this.x + 1 : mode === 2 ? this.cols : this.cols;
    for (let i = from; i < to && i < this.cols; i++) l[i] = BLANK;
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) return void this.clear();
    if (mode === 1) { for (let y = 0; y < this.y; y++) this.buf[y].fill(BLANK); this.eraseLine(1); return; }
    this.eraseLine(0);
    for (let y = this.y + 1; y < this.rows; y++) this.line(y).fill(BLANK);
  }

  write(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        const rest = s.slice(i);
        const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(rest);
        if (csi) { i += csi[0].length - 1; this.csi(csi[1], csi[2]); continue; }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);     // заголовок окна и прочее — мимо
        if (osc) { i += osc[0].length - 1; continue; }
        if (rest[1] === 'c') { i++; this.clear(); continue; }           // полный сброс
        if (/^\x1b[()][B0]/.test(rest)) { i += 2; continue; }
        i++;                                                            // одиночный ESC — пропускаем
        continue;
      }
      if (ch === '\n') { this.down(); continue; }
      if (ch === '\r') { this.x = 0; continue; }
      if (ch === '\b') { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); continue; }
      if (ch === '\x07' || ch === '\x00') continue;
      this.put(ch);
    }
    return this;
  }

  csi(args, final) {
    const n = args.replace('?', '').split(';').map(v => (v === '' ? null : +v));
    const a = n[0] ?? 1, b = n[1] ?? 1;
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - a); break;
      case 'B': this.y = Math.min(this.rows - 1, this.y + a); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + a); break;
      case 'D': this.x = Math.max(0, this.x - a); break;
      case 'E': this.y = Math.min(this.rows - 1, this.y + a); this.x = 0; break;
      case 'F': this.y = Math.max(0, this.y - a); this.x = 0; break;
      case 'G': this.x = Math.max(0, Math.min(this.cols - 1, a - 1)); break;
      case 'H': case 'f': this.y = Math.max(0, Math.min(this.rows - 1, a - 1)); this.x = Math.max(0, Math.min(this.cols - 1, b - 1)); break;
      case 'J': this.eraseDisplay(n[0] ?? 0); break;
      case 'K': this.eraseLine(n[0] ?? 0); break;
      case 'L': for (let k = 0; k < a; k++) { this.buf.splice(this.y, 0, Array(this.cols).fill(BLANK)); this.buf.length = this.rows; } break;
      case 'M': for (let k = 0; k < a; k++) { this.buf.splice(this.y, 1); this.buf.push(Array(this.cols).fill(BLANK)); } break;
      case 'P': { const l = this.line(this.y); l.splice(this.x, a); while (l.length < this.cols) l.push(BLANK); break; }
      case 'X': { const l = this.line(this.y); for (let k = 0; k < a && this.x + k < this.cols; k++) l[this.x + k] = BLANK; break; }
      case 'h': if (args.includes('1049')) this.clear(); break;        // переход на «второй экран»
      case 'l': if (args.includes('1049')) this.clear(); break;
      default: break;                                                   // цвета (m) и остальное нам не нужны
    }
  }

  // то, что сейчас видно на экране: хвостовые пробелы и пустые строки сверху-снизу убираем
  text() {
    const rows = this.buf.map(r => r.join('').replace(/\s+$/, ''));
    let a = 0, b = rows.length;
    while (a < b && !rows[a].trim()) a++;
    while (b > a && !rows[b - 1].trim()) b--;
    return rows.slice(a, b).join('\n');
  }
}
