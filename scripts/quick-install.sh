#!/usr/bin/env bash
set -euo pipefail

REPO_URL=${DEPO_REPO_URL:-https://github.com/banhanman/depo.git}
INSTALL_DIR=${DEPO_INSTALL_DIR:-$HOME/depo}
NODE_VERSION=${DEPO_NODE_VERSION:-24.20.0}
DEPO_LOGIN=${DEPO_LOGIN:-$(id -un)}
DEPO_PASSWORD=${DEPO_PASSWORD:-}

fail() {
  echo "$1" >&2
  exit 1
}

for command_name in curl git tar sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Не найдена команда: $command_name"
done

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; then
  case $(uname -m) in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    *) fail "Архитектура $(uname -m) не поддерживается автоматическим установщиком." ;;
  esac
  NODE_DIST="node-v$NODE_VERSION-linux-$NODE_ARCH"
  RUNTIME_ROOT=${DEPO_RUNTIME_DIR:-$HOME/.local/share/depo}
  NODE_BIN="$RUNTIME_ROOT/$NODE_DIST/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    BASE_URL="https://nodejs.org/dist/v$NODE_VERSION"
    echo "Загрузка Node.js $NODE_VERSION…"
    curl -fL --retry 3 -o "$TMP/$NODE_DIST.tar.gz" "$BASE_URL/$NODE_DIST.tar.gz"
    curl -fsSL --retry 3 -o "$TMP/SHASUMS256.txt" "$BASE_URL/SHASUMS256.txt"
    EXPECTED=$(awk -v file="$NODE_DIST.tar.gz" '$2 == file {print $1}' "$TMP/SHASUMS256.txt")
    [ -n "$EXPECTED" ] || fail "Не удалось получить контрольную сумму Node.js."
    ACTUAL=$(sha256sum "$TMP/$NODE_DIST.tar.gz" | cut -d' ' -f1)
    [ "$ACTUAL" = "$EXPECTED" ] || fail "Контрольная сумма Node.js не совпала."
    mkdir -p "$RUNTIME_ROOT"
    tar -xzf "$TMP/$NODE_DIST.tar.gz" -C "$RUNTIME_ROOT"
    rm -rf "$TMP"
    trap - EXIT
  fi
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  CURRENT_REMOTE=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)
  [ "$CURRENT_REMOTE" = "$REPO_URL" ] || fail "Каталог $INSTALL_DIR уже связан с другим репозиторием."
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  fail "Каталог $INSTALL_DIR не пуст. Выберите другой путь через DEPO_INSTALL_DIR."
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

if [ -z "$DEPO_PASSWORD" ]; then
  [ -r /dev/tty ] || fail "Задайте DEPO_LOGIN и DEPO_PASSWORD для неинтерактивной установки."
  read -r -p "Логин владельца [$DEPO_LOGIN]: " INPUT_LOGIN < /dev/tty
  DEPO_LOGIN=${INPUT_LOGIN:-$DEPO_LOGIN}
  while true; do
    read -r -s -p "Пароль владельца (минимум 8 символов): " FIRST_PASSWORD < /dev/tty
    printf '\n' > /dev/tty
    read -r -s -p "Повторите пароль: " SECOND_PASSWORD < /dev/tty
    printf '\n' > /dev/tty
    [ "$FIRST_PASSWORD" = "$SECOND_PASSWORD" ] || { echo "Пароли не совпадают." > /dev/tty; continue; }
    [ "${#FIRST_PASSWORD}" -ge 8 ] || { echo "Пароль слишком короткий." > /dev/tty; continue; }
    DEPO_PASSWORD=$FIRST_PASSWORD
    break
  done
fi

export DEPO_LOGIN DEPO_PASSWORD
"$NODE_BIN" "$INSTALL_DIR/scripts/setup.mjs"
unset DEPO_PASSWORD

if [ "$(id -u)" -eq 0 ]; then
  DEPO_NODE="$NODE_BIN" bash "$INSTALL_DIR/scripts/install.sh"
else
  command -v sudo >/dev/null 2>&1 || fail "Для регистрации systemd-службы нужен sudo."
  sudo DEPO_NODE="$NODE_BIN" bash "$INSTALL_DIR/scripts/install.sh"
fi
