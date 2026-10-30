#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
MODE=${1:-main}
TARGET_USER=${SUDO_USER:-$(id -un)}
TARGET_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
NODE_BIN=${DEPO_NODE:-$(command -v node || true)}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "$1" >&2
  exit 1
}

render() {
  local content
  content=$(<"$1")
  content=${content//__DEPO_USER__/$TARGET_USER}
  content=${content//__DEPO_HOME__/$TARGET_HOME}
  content=${content//__DEPO_ROOT__/$ROOT}
  content=${content//__DEPO_NODE__/$NODE_BIN}
  printf '%s\n' "$content" > "$2"
}

[ "$(id -u)" -eq 0 ] || fail "Запустите установщик через sudo."
[ -n "$TARGET_HOME" ] || fail "Не удалось определить домашний каталог пользователя $TARGET_USER."
[ -f "$ROOT/server.mjs" ] || fail "Файл $ROOT/server.mjs не найден."
[ -f "$ROOT/.env" ] || fail "Сначала выполните настройку Depo."
[ -n "$NODE_BIN" ] || fail "Node.js не найден."
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || fail "Нужен Node.js 22.5 или новее."
command -v systemctl >/dev/null 2>&1 || fail "systemd не найден."

if [ "$MODE" = "--voice" ]; then
  [ -x "$ROOT/voice/venv/bin/python" ] || fail "Голосовое окружение не установлено."
  render "$ROOT/systemd/depo-voice.service" "$TMP/depo-voice.service"
  install -m 644 "$TMP/depo-voice.service" /etc/systemd/system/depo-voice.service
  systemctl daemon-reload
  systemctl enable --now depo-voice.service
  systemctl restart depo-voice.service
  echo "Служба depo-voice запущена."
  exit 0
fi

render "$ROOT/systemd/depo.service" "$TMP/depo.service"
render "$ROOT/systemd/depo-backup.service" "$TMP/depo-backup.service"
install -m 644 "$TMP/depo.service" /etc/systemd/system/depo.service
install -m 644 "$TMP/depo-backup.service" /etc/systemd/system/depo-backup.service
install -m 644 "$ROOT/systemd/depo-backup.timer" /etc/systemd/system/depo-backup.timer
systemctl daemon-reload
systemctl enable --now depo.service
systemctl enable --now depo-backup.timer

PORT=$("$NODE_BIN" -e 'for(const l of require("node:fs").readFileSync(process.argv[1],"utf8").split("\n")){if(l.startsWith("PORT=")){console.log(l.slice(5));process.exit(0)}}console.log("4620")' "$ROOT/.env")
IP=$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)

if curl -fsS --retry 8 --retry-delay 1 --retry-connrefused --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null; then
  echo "Depo запущен: http://${IP:-127.0.0.1}:$PORT"
else
  fail "Служба установлена, но проверка /health не прошла. Выполните: journalctl -u depo -n 50"
fi
