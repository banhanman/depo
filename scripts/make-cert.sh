#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
DIR="$ROOT/data/tls"
mkdir -p "$DIR"
cd "$DIR"
IP=${1:-$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)}
[ -n "$IP" ] || { echo "Укажите IP-адрес сервера первым аргументом." >&2; exit 1; }
HOST=$(hostname)

if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 4096 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Depo Local CA ($HOST)/O=Depo" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
  echo "CA создан: $DIR/ca.crt"
fi

cat > san.cnf <<CNF
[req]
distinguished_name=dn
[dn]
[ext]
subjectAltName=IP:$IP,IP:127.0.0.1,DNS:$HOST,DNS:localhost
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
basicConstraints=CA:FALSE
CNF
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/CN=Depo $HOST" -config san.cnf -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile san.cnf -extensions ext -out server.crt 2>/dev/null
rm -f server.csr san.cnf
chmod 600 ca.key server.key
echo "сертификат сервера: $DIR/server.crt (IP $IP, $HOST)"
openssl x509 -in server.crt -noout -ext subjectAltName | tail -1
