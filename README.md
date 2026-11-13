# Bot de Discord · StreamShopp

Cada ~30 minutos (GitHub Actions):
- **#📦┃stock** — aviso estilo "PRODUCTO REPUESTO" (servicio, stock, precio, botón y foto) cuando algo vuelve a tener stock o recibe 3+ unidades.
- **#💜┃ventas** — feed público y anónimo: "» Un Crack 🟢 acaba de comprar 1x Netflix usando PayPal".

Secretos (Settings → Secrets and variables → Actions):
- `SELLAUTH_API_KEY` — clave de SellAuth (solo lectura)
- `DISCORD_WEBHOOK_URL` — webhook de #📦┃stock
- `DISCORD_SALES_WEBHOOK_URL` — webhook de #💜┃ventas (opcional; sin él no hay feed de ventas)

La primera ejecución de cada parte solo guarda el estado; los avisos empiezan en la siguiente.
