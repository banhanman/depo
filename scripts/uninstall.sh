#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Запустите удаление через sudo." >&2; exit 1; }
systemctl disable --now depo.service depo-voice.service depo-backup.timer 2>/dev/null || true
rm -f /etc/systemd/system/depo.service /etc/systemd/system/depo-voice.service /etc/systemd/system/depo-backup.service /etc/systemd/system/depo-backup.timer
systemctl daemon-reload
echo "Службы Depo удалены. Код, данные и резервные копии сохранены."
