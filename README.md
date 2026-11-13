# Bot de reposiciones · StreamShopp

Cada ~30 minutos (repo privado: así cabe en los 2.000 min gratis de Actions al mes) revisa el stock de la tienda en SellAuth y publica un aviso en `#reposiciones` cuando un producto vuelve a estar disponible.

Secretos del repo (Settings → Secrets and variables → Actions):
- `SELLAUTH_API_KEY` — clave de API de SellAuth (solo lectura)
- `SELLAUTH_SHOP_ID` — 194636
- `DISCORD_WEBHOOK_URL` — webhook del canal #reposiciones

La primera ejecución solo guarda el estado; los avisos empiezan a partir de la segunda.
