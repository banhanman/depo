# Проводник: доступ к Depo из интернета без NetBird на телефоне

Depo живёт дома (Raspberry Pi, мини-сервер) и виден только внутри NetBird. Проводник — арендованный VPS,
который тоже стоит в NetBird и принимает обычный https на вашем домене:

```
телефон ──https──▶ depo.example.ru (VPS: Nginx Proxy Manager + Let's Encrypt)
        ──▶ пересыльщик (socat) ──туннель NetBird──▶ Depo :4620
```

Наружу открыт только 443 с паролем Depo и ограничением попыток входа. Выключатель «Удалённый доступ»
в настройках Depo работает на самом Depo: запросы на домен получают 403, даже если проводник запущен.

## Шаги

1. **NetBird.** В панели NetBird (Setup Keys) создайте ключ для сервера-проводника.
2. **Сервер.** Нужен Docker. Скопируйте `docker-compose.yml` в `/opt/depo-relay/`, рядом создайте `.env`
   со строкой `NB_SETUP_KEY=…` (права 600), замените `100.x.y.z` на адрес Depo в NetBird
   (в настройках Depo → «Доступ» он подставлен сам) и, если нужно, `bind` — шлюз docker-сети вашего
   обратного прокси (`docker network inspect <сеть>` → Gateway). Затем:
   ```sh
   cd /opt/depo-relay && docker compose up -d
   docker exec depo-relay-netbird netbird status   # Connected, видны пиры
   ```
   `forward-web` слушает только шлюз docker-сети прокси — снаружи не виден. `forward-ip` открывает
   `https://IP:4621` — вход прямо по IP с сертификатом Depo (тот же CA, что уже стоит на телефоне;
   Depo сам добавит IP проводника в сертификат). Оба порта открываются, только когда Depo отвечает
   на `/api/remote` — то есть умеет выключатель доступа. Всё стартует само после перезагрузки сервера.
3. **DNS.** A-запись домена → публичный IP сервера.
4. **Обратный прокси.** В Nginx Proxy Manager: Add Proxy Host → домен, Forward `http://172.17.0.1:14620`,
   Websockets Support, Block Common Exploits; SSL → Let's Encrypt, Force SSL; Advanced:
   ```nginx
   proxy_buffering off;
   proxy_read_timeout 1h;
   ```
   (без этого живая лента ответов агентов приходит рывками). Если на сервере свой nginx или Caddy —
   то же самое: TLS на домене и `proxy_pass http://172.17.0.1:14620` с отключённой буферизацией.
5. **Depo.** Настройки → «Доступ»: домен, IP сервера, «Проверить снаружи», включить.

## Откат

`cd /opt/depo-relay && docker compose down` и удалить Proxy Host. Остальные сервисы на VPS не затрагиваются.
