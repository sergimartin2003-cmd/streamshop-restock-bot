// Bot de StreamShopp para Discord:
//  1) #📦┃stock  → aviso cuando un producto vuelve a tener stock (o recibe más)
//  2) #💜┃ventas → feed público y anónimo de compras ("Un Crack acaba de comprar 1x Netflix usando PayPal")
import fs from 'node:fs';

const {
  SELLAUTH_API_KEY,
  SELLAUTH_SHOP_ID,
  DISCORD_WEBHOOK_URL, // canal de stock
  DISCORD_SALES_WEBHOOK_URL, // canal de ventas (opcional)
  SHOP_URL = 'https://streamshopp.mysellauth.com',
} = process.env;
if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID || !DISCORD_WEBHOOK_URL) {
  console.error('Faltan secretos: SELLAUTH_API_KEY, SELLAUTH_SHOP_ID o DISCORD_WEBHOOK_URL');
  process.exit(1);
}
const STATE = 'state.json';
const SALES = 'sales.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const r = await fetch(`https://api.sellauth.com/v1${path}`, {
    headers: { Authorization: `Bearer ${SELLAUTH_API_KEY}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`SellAuth ${r.status} en ${path.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function post(url, body) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429) { await sleep(((await res.json().catch(() => ({}))).retry_after || 2) * 1000); continue; }
    if (!res.ok) console.error('Discord', res.status, (await res.text()).slice(0, 200));
    return;
  }
}

const money = (v, cur = 'EUR') => {
  const n = Number(v);
  if (!isFinite(n)) return `${v} ${cur}`;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur || 'EUR' }).format(n);
};

/* ───────────── 1) STOCK ───────────── */

const qty = (s) => (s === null || s === undefined || Number(s) < 0 ? Infinity : Number(s) || 0);

async function loadProducts() {
  // Paginación robusta: SellAuth no siempre respeta perPage ni devuelve last_page,
  // así que seguimos pidiendo páginas hasta que una venga vacía o repetida.
  const byId = new Map();
  for (let page = 1; page <= 30; page++) {
    const res = await api(`/shops/${SELLAUTH_SHOP_ID}/products?page=${page}&perPage=100&per_page=100`);
    const list = Array.isArray(res) ? res : res.data || [];
    let added = 0;
    for (const p of list) if (!byId.has(p.id)) { byId.set(p.id, p); added++; }
    const last = res.last_page ?? res.meta?.last_page;
    if (Array.isArray(res) || list.length === 0 || added === 0) break;
    if (last && page >= last) break;
    if (!last && res.next_page_url === null) break;
  }
  return [...byId.values()];
}

function imageOf(p) {
  return p.image_url || p.images?.[0]?.url || p.image_urls?.[0] || null;
}

function snapshot(products) {
  const snap = {};
  for (const p of products) {
    if (p.type === 'group') continue;
    if (p.visibility && p.visibility !== 'public') continue;
    const vars = Array.isArray(p.variants) && p.variants.length ? p.variants : [{ id: 'base', name: '', stock: p.stock }];
    for (const v of vars) {
      if (v.visibility && v.visibility !== 'public') continue;
      const stock = qty(v.stock ?? v.stock_count);
      snap[`${p.id}:${v.id}`] = {
        name: v.name && vars.length > 1 ? `${p.name} — ${v.name}` : p.name,
        service: p.name,
        variant: vars.length > 1 ? v.name || '' : '',
        stock: stock === Infinity ? -1 : stock,
        price: v.price ?? p.price ?? null,
        currency: p.currency || 'EUR',
        url: `${SHOP_URL}/product/${p.path || p.slug || p.id}`,
        image: imageOf(p),
      };
    }
  }
  return snap;
}

function restockEmbed(r) {
  const lines = [
    `🛍️ **Servicio:** ${r.service}`,
    ...(r.variant ? [`🏷️ **Variante:** ${r.variant}`] : []),
    `📦 **Stock disponible:** ${r.stock === -1 ? 'ilimitado' : r.stock}`,
    ...(r.price != null ? [`💰 **Precio:** ${money(r.price, r.currency)}`] : []),
    '',
    `🔗 **[Comprar ahora](${r.url})**`,
  ];
  return {
    title: r.kind === 'vuelve' ? '✨ STREAMSHOPP · PRODUCTO REPUESTO ✨' : '📦 STREAMSHOPP · STOCK AÑADIDO 📦',
    url: r.url,
    description: lines.join('\n'),
    color: 0x19d98e,
    ...(r.image ? { image: { url: r.image } } : {}),
    footer: { text: 'StreamShopp · Entrega instantánea 24/7' },
    timestamp: new Date().toISOString(),
  };
}

async function runStock() {
  const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  const now = snapshot(await loadProducts());
  if (!prev) {
    fs.writeFileSync(STATE, JSON.stringify(now, null, 2));
    console.log(`Stock: primera ejecución, guardados ${Object.keys(now).length} productos.`);
    return;
  }
  const restocks = [];
  for (const [k, item] of Object.entries(now)) {
    if (!prev[k]) continue; // producto nuevo o que no se leyó la vez anterior: sin aviso
    const was = prev[k].stock === -1 ? Infinity : prev[k].stock;
    const is = item.stock === -1 ? Infinity : item.stock;
    if (was === 0 && is > 0) restocks.push({ ...item, kind: 'vuelve' });
    else if (was > 0 && is !== Infinity && is - was >= 3) restocks.push({ ...item, kind: 'mas' });
  }
  for (const r of restocks.slice(0, 10)) {
    await post(DISCORD_WEBHOOK_URL, { username: 'StreamShopp Stock', embeds: [restockEmbed(r)] });
    await sleep(1200);
  }
  // Si la API devolvió muy pocos productos (fallo puntual), conserva el estado anterior de los que faltan.
  // Si la lectura es normal, los que faltan se consideran borrados y se quitan del estado.
  const nPrev = Object.keys(prev).length, nNow = Object.keys(now).length;
  if (nNow < nPrev * 0.5) for (const [k, v] of Object.entries(prev)) if (!now[k]) now[k] = v;
  fs.writeFileSync(STATE, JSON.stringify(now, null, 2));
  console.log(`Stock: ${Object.keys(now).length} productos revisados, ${restocks.length} avisos.`);
}

/* ───────────── 2) VENTAS (feed anónimo) ───────────── */

const NICKS = [
  ['Un Crack', '🟢'], ['Un Máquina', '💜'], ['Un Fenómeno', '🔥'], ['Un Jefe', '👑'], ['Una Leyenda', '⭐'],
  ['Un Titán', '⚡'], ['Un Pro', '💎'], ['Un Grande', '🟣'], ['Un Visionario', '🚀'], ['Un Campeón', '🏆'],
];
const COLORS = [0x7a5cff, 0x19d98e, 0xffb020, 0xff4d8d, 0x2fb6ff, 0xa06bff];

function payMethod(inv) {
  const g = String(inv.gateway || inv.payment_method?.name || '').toUpperCase();
  if (!g) return 'otro método';
  if (g.includes('PAYPAL')) return 'PayPal';
  if (/STRIPE|CARD|SUMUP|SQUARE|CREDIT|APPLE|GOOGLE/.test(g)) return 'Tarjeta';
  if (/BTC|ETH|LTC|USDT|USDC|SOL|CRYPTO|COIN|XMR|TRX|BNB|DOGE/.test(g)) return 'Cripto';
  if (g.includes('BALANCE')) return 'Saldo';
  return g.charAt(0) + g.slice(1).toLowerCase();
}

function itemsText(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  if (!items.length) return 'un producto';
  return items
    .map((it) => {
      const name = it.custom_name || it.product?.name || 'producto';
      return `${it.quantity || 1}x ${name}`;
    })
    .join(', ');
}

async function runSales() {
  if (!DISCORD_SALES_WEBHOOK_URL) {
    console.log('Ventas: sin DISCORD_SALES_WEBHOOK_URL, me lo salto.');
    return;
  }
  const res = await api(
    `/shops/${SELLAUTH_SHOP_ID}/invoices?statuses[]=completed&orderColumn=completed_at&orderDirection=desc&perPage=25`,
  );
  const list = (Array.isArray(res) ? res : res.data || []).filter((i) => i.status === 'completed');
  const seen = fs.existsSync(SALES) ? JSON.parse(fs.readFileSync(SALES, 'utf8')) : null;
  const ids = list.map((i) => String(i.id));
  if (!seen) {
    fs.writeFileSync(SALES, JSON.stringify({ ids: ids.slice(0, 200) }, null, 2));
    console.log(`Ventas: primera ejecución, marcadas ${ids.length} ventas antiguas como vistas.`);
    return;
  }
  const known = new Set(seen.ids);
  const fresh = list.filter((i) => !known.has(String(i.id))).reverse(); // de más antigua a más nueva
  const embeds = fresh.map((inv, n) => {
    const [nick, dot] = NICKS[(Number(inv.id) + n) % NICKS.length] || NICKS[0];
    return {
      description: `» ${nick} ${dot} acaba de comprar **${itemsText(inv)}** usando **${payMethod(inv)}**. ¡Gracias por confiar en **StreamShopp**! 💜`,
      color: COLORS[Number(inv.id) % COLORS.length],
    };
  });
  for (let i = 0; i < embeds.length; i += 10) {
    await post(DISCORD_SALES_WEBHOOK_URL, { username: 'StreamShopp Ventas', embeds: embeds.slice(i, i + 10) });
    await sleep(1200);
  }
  fs.writeFileSync(SALES, JSON.stringify({ ids: [...new Set([...ids, ...seen.ids])].slice(0, 200) }, null, 2));
  console.log(`Ventas: ${fresh.length} nuevas publicadas.`);
}

// Modo prueba (Run workflow → marcar "prueba"): manda un ejemplo a cada webhook y termina.
if (process.env.PRUEBA === '1') {
  const prods = Object.values(snapshot(await loadProducts()));
  const p = prods.find((x) => x.stock !== 0) || prods[0];
  if (p) await post(DISCORD_WEBHOOK_URL, { username: 'StreamShopp Stock', content: '🧪 **PRUEBA** del aviso de stock (no es un restock real)', embeds: [restockEmbed({ ...p, kind: 'vuelve' })] });
  else await post(DISCORD_WEBHOOK_URL, { username: 'StreamShopp Stock', content: '🧪 PRUEBA: webhook de stock OK' });
  if (DISCORD_SALES_WEBHOOK_URL) {
    await sleep(1200);
    await post(DISCORD_SALES_WEBHOOK_URL, {
      username: 'StreamShopp Ventas',
      content: '🧪 **PRUEBA** del feed de ventas (no es una venta real)',
      embeds: [{ description: `» Un Crack 🟢 acaba de comprar **1x ${p?.service || 'Netflix'}** usando **PayPal**. ¡Gracias por confiar en **StreamShopp**! 💜`, color: 0x7a5cff }],
    });
  } else console.log('Prueba: falta DISCORD_SALES_WEBHOOK_URL');
  console.log('Prueba enviada.');
  process.exit(0);
}

/* ───────────── 3) CONTADOR DE VENTAS EN STATS (canal de voz) ───────────── */

const STATS_FILE = 'stats.json';
const fmtNum = (n) => new Intl.NumberFormat('es-ES').format(n);

async function countSales() {
  // Total de pedidos completados según SellAuth (usa el total de la paginación; si no viene, cuenta páginas).
  const first = await api(`/shops/${SELLAUTH_SHOP_ID}/invoices?statuses[]=completed&perPage=100&page=1`);
  const total = first.total ?? first.meta?.total;
  if (Number.isFinite(Number(total))) return Number(total);
  let n = 0;
  for (let page = 1; page <= 200; page++) {
    const res = page === 1 ? first : await api(`/shops/${SELLAUTH_SHOP_ID}/invoices?statuses[]=completed&perPage=100&page=${page}`);
    const list = (Array.isArray(res) ? res : res.data || []).filter((i) => i.status === 'completed');
    n += list.length;
    if (!list.length || Array.isArray(res) || (res.last_page && page >= res.last_page) || res.next_page_url === null) break;
  }
  return n;
}

async function runStats() {
  const { DISCORD_BOT_TOKEN, STATS_CHANNEL_ID } = process.env;
  if (!DISCORD_BOT_TOKEN || !STATS_CHANNEL_ID) {
    console.log('Stats: falta DISCORD_BOT_TOKEN o STATS_CHANNEL_ID, me lo salto.');
    return;
  }
  const total = await countSales();
  const name = `📈┃${fmtNum(total)}${total > 0 ? '+' : ''} ventas`;
  const prev = fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) : {};
  if (prev.name === name) {
    console.log(`Stats: sin cambios (${name}).`);
    return;
  }
  // Discord permite 2 renombres cada 10 min por canal: solo renombramos si cambia el número.
  const r = await fetch(`https://discord.com/api/v10/channels/${STATS_CHANNEL_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': 'Contador de ventas' },
    body: JSON.stringify({ name }),
  });
  if (r.status === 429) {
    console.log('Stats: Discord limita el renombrado ahora mismo, se reintenta en la próxima ejecución.');
    return;
  }
  if (!r.ok) throw new Error(`Discord ${r.status} al renombrar: ${(await r.text()).slice(0, 200)}`);
  fs.writeFileSync(STATS_FILE, JSON.stringify({ name, total, updated: new Date().toISOString() }, null, 2));
  console.log(`Stats: canal renombrado a "${name}".`);
}

let failed = false;
for (const [name, fn] of [['stock', runStock], ['ventas', runSales], ['stats', runStats]]) {
  try { await fn(); } catch (e) { failed = true; console.error(`Error en ${name}:`, e.message); }
}
if (failed) process.exitCode = 1;
