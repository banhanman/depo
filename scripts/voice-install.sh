#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT/voice"
BIG=${1:-}

command -v python3 >/dev/null 2>&1 || { echo "Установите Python 3 и python3-venv." >&2; exit 1; }
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install --quiet --disable-pip-version-check vosk
if [ ! -d vosk-model-small-ru-0.22 ]; then
  curl -fL --retry 3 -o m.zip https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip
  python3 -c "import zipfile; zipfile.ZipFile('m.zip').extractall('.')"
  rm m.zip
fi
if [ "$BIG" = "--big" ] && [ ! -d vosk-model-ru-0.42 ]; then
  echo "Загрузка большой модели (1,8 ГБ)…"
  curl -fL --retry 3 -o big.zip https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip
  python3 -c "import zipfile; zipfile.ZipFile('big.zip').extractall('.')"
  rm big.zip
  grep -q DEPO_VOSK_MODEL "$ROOT/.env" || echo "DEPO_VOSK_MODEL=$ROOT/voice/vosk-model-ru-0.42" >> "$ROOT/.env"
fi
sudo bash "$ROOT/scripts/install.sh" --voice
curl -fsS --retry 8 --retry-delay 1 --retry-connrefused http://127.0.0.1:2701/health
echo
echo "Голосовой ввод готов."
