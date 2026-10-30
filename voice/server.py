#!/usr/bin/env python3
import json, os, re, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from vosk import Model, KaldiRecognizer, SetLogLevel
SetLogLevel(-1)

HERE = os.path.dirname(os.path.abspath(__file__))
VOSK_DIR = os.environ.get('DEPO_VOSK_MODEL') or os.path.join(HERE, 'vosk-model-small-ru-0.22')
WHISPER = os.environ.get('DEPO_WHISPER_MODEL', 'small')
PORT = int(os.environ.get('DEPO_VOICE_PORT', '2701'))
RATE = 16000
IDLE_SEC = 300

t0 = time.time()
vosk_model = Model(VOSK_DIR)
print(f'vosk {os.path.basename(VOSK_DIR)} за {time.time()-t0:.1f} с', flush=True)

whisper = None
whisper_err = None
def load_whisper():
    global whisper, whisper_err
    try:
        from faster_whisper import WhisperModel
        t = time.time()
        whisper = WhisperModel(WHISPER, device='cpu', compute_type='int8',
                               download_root=os.path.join(HERE, 'whisper'))
        print(f'whisper {WHISPER} за {time.time()-t:.1f} с', flush=True)
    except Exception as e:
        whisper_err = str(e)
        print('whisper не поднялся:', e, flush=True)
threading.Thread(target=load_whisper, daemon=True).start()

sessions = {}
lock = threading.Lock()

class Sess:
    def __init__(self):
        self.rec = KaldiRecognizer(vosk_model, RATE)
        self.pcm = bytearray()
        self.final = []
        self.at = time.time()

def reap():
    now = time.time()
    with lock:
        for k in [k for k, v in sessions.items() if now - v.at > IDLE_SEC]:
            sessions.pop(k, None)

def clean(text):
    t = re.sub(r'\s+', ' ', (text or '')).strip()
    parts = [p for p in re.split(r'(?<=[.!?…])\s+', t) if p]
    out = []
    for p in parts:
        if len(out) >= 2 and p == out[-1] == out[-2]:
            continue
        out.append(p)
    return ' '.join(out)

def transcribe(pcm, draft=''):
    if whisper is None or len(pcm) < RATE:
        return None
    import numpy as np
    audio = np.frombuffer(bytes(pcm), dtype=np.int16).astype(np.float32) / 32768.0
    segs, info = whisper.transcribe(
        audio, language=None, task='transcribe', beam_size=1, vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt='Диктовка разработчика. Сохраняй английские слова и термины латиницей: '
                       'Claude, Codex, Depo, git, commit, deploy, API, Docker, systemd. Расставляй знаки препинания.')
    text = clean(' '.join(s.text for s in segs))
    return {'text': text, 'language': info.language, 'prob': round(info.language_probability or 0, 2)}

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = int(self.headers.get('content-length') or 0)
        return self.rfile.read(n) if n > 0 else b''

    def do_GET(self):
        if urlparse(self.path).path == '/health':
            return self._j(200, {'ok': True, 'vosk': os.path.basename(VOSK_DIR),
                                 'whisper': WHISPER if whisper else None,
                                 'whisper_loading': whisper is None and whisper_err is None,
                                 'whisper_error': whisper_err})
        self._j(404, {'error': 'нет'})

    def do_POST(self):
        u = urlparse(self.path); q = parse_qs(u.query); reap()
        if u.path == '/start':
            sid = uuid.uuid4().hex
            with lock: sessions[sid] = Sess()
            return self._j(200, {'id': sid})

        if u.path == '/feed':
            sid = (q.get('id') or [''])[0]
            with lock: s = sessions.get(sid)
            if not s: return self._j(404, {'error': 'сессия не найдена'})
            pcm = self._body()
            s.at = time.time(); s.pcm += pcm
            partial = ''
            if s.rec.AcceptWaveform(bytes(pcm)):
                r = json.loads(s.rec.Result()).get('text', '')
                if r: s.final.append(r)
            else:
                partial = json.loads(s.rec.PartialResult()).get('partial', '')
            draft = ' '.join(x for x in (s.final + [partial]) if x).strip()
            return self._j(200, {'draft': draft, 'seconds': round(len(s.pcm) / (RATE * 2), 1)})

        if u.path == '/stop':
            sid = (q.get('id') or [''])[0]
            with lock: s = sessions.pop(sid, None)
            if not s: return self._j(404, {'error': 'сессия не найдена'})
            tailpcm = self._body()
            if tailpcm: s.pcm += tailpcm; s.rec.AcceptWaveform(bytes(tailpcm))
            last = json.loads(s.rec.FinalResult()).get('text', '')
            if last: s.final.append(last)
            draft = ' '.join(s.final).strip()
            t = time.time()
            fine = transcribe(s.pcm, draft)
            return self._j(200, {'text': (fine or {}).get('text') or draft, 'draft': draft,
                                 'engine': 'whisper' if fine else 'vosk',
                                 'language': (fine or {}).get('language'),
                                 'seconds': round(len(s.pcm) / (RATE * 2), 1), 'took': round(time.time() - t, 2)})

        if u.path == '/transcribe':                 # разовый файл целиком (запасной путь)
            pcm = self._body()
            if not pcm: return self._j(400, {'error': 'пусто'})
            rec = KaldiRecognizer(vosk_model, RATE); rec.AcceptWaveform(bytes(pcm))
            draft = json.loads(rec.FinalResult()).get('text', '')
            fine = transcribe(pcm, draft)
            return self._j(200, {'text': (fine or {}).get('text') or draft, 'draft': draft,
                                 'engine': 'whisper' if fine else 'vosk',
                                 'seconds': round(len(pcm) / (RATE * 2), 1)})
        self._j(404, {'error': 'нет'})

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
