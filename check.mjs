// Bot de reposiciones StreamShopp: mira el stock en SellAuth y avisa en Discord
// cuando un producto pasa de agotado a disponible (o recibe más stock).
import fs from 'node:fs';

const { SELLAUTH_API_KEY, SELLAUTH_SHOP_ID, DISCORD_WEBHOOK_URL, SHOP_URL = 'https://streamshopp.mysellauth.com' } = process.env;
if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID || !DISCORD_WEBHOOK_URL) {
  console.error('Faltan secretos: SELLAUTH_API_KEY, SELLAUTH_SHOP_ID o DISCORD_WEBHOOK_URL');
  process.exit(1);
}
const STATE = 'state.json';

async function api(path) {
  const r = await fetch(`https://api.sellauth.com/v1${path}`, {
    headers: { Authorization: `Bearer ${SELLAUTH_API_KEY}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`SellAuth ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// -1 / null = ilimitado en SellAuth
const qty = (s) => (s === null || s === undefined || Number(s) < 0 ? Infinity : Number(s) || 0);

async function loadProducts() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const res = await api(`/shops/${SELLAUTH_SHOP_ID}/products?page=${page}&perPage=100`);
    const list = Array.isArray(res) ? res : res.data || [];
    all.push(...list);
    const last = res.last_page ?? res.meta?.last_page ?? 1;
    if (Array.isArray(res) || page >= last || list.length === 0) break;
  }
  return all;
}

function snapshot(products) {
  const snap = {};
  for (const p of products) {
    if (p.type === 'group') continue;
    if (p.visibility && p.visibility !== 'public') continue; // solo productos visibles
    const vars = Array.isArray(p.variants) && p.variants.length ? p.variants : [{ id: 'base', name: '', stock: p.stock }];
    for (const v of vars) {
      if (v.visibility && v.visibility !== 'public') continue;
      const key = `${p.id}:${v.id}`;
      const stock = qty(v.stock ?? v.stock_count);
      snap[key] = {
        name: v.name && vars.length > 1 ? `${p.name} — ${v.name}` : p.name,
        stock: stock === Infinity ? -1 : stock,
        price: v.price ?? p.price ?? null,
        currency: p.currency || 'EUR',
        url: `${SHOP_URL}/product/${p.path || p.slug || p.id}`,
        image: p.image_url || (p.images && p.images[0]?.url) || null,
      };
    }
  }
  return snap;
}

const prev = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
const now = snapshot(await loadProducts());

if (!prev) {
  fs.writeFileSync(STATE, JSON.stringify(now, null, 2));
  console.log(`Primera ejecución: guardado el estado de ${Object.keys(now).length} productos, sin avisos.`);
  process.exit(0);
}

const restocks = [];
for (const [k, item] of Object.entries(now)) {
  const before = prev[k]?.stock ?? 0;
  const after = item.stock;
  const was = before === -1 ? Infinity : before;
  const is = after === -1 ? Infinity : after;
  if (was === 0 && is > 0) restocks.push({ ...item, kind: 'vuelve' });
  else if (was > 0 && is !== Infinity && is - was >= 3) restocks.push({ ...item, kind: 'mas', added: is - was });
}

const fmt = (n) => (n === -1 ? 'ilimitado' : `${n} uds.`);
for (const r of restocks.slice(0, 10)) {
  const embed = {
    title: r.kind === 'vuelve' ? `🔔 ¡${r.name} vuelve a estar disponible!` : `📦 Stock nuevo de ${r.name}`,
    url: r.url,
    description: r.kind === 'vuelve'
      ? `Hemos repuesto **${r.name}**. Entrega automática al instante.`
      : `Acabamos de añadir **${r.added}** unidades de **${r.name}**.`,
    color: 0x7a5cff,
    fields: [
      { name: 'Stock', value: fmt(r.stock), inline: true },
      ...(r.price ? [{ name: 'Precio', value: `${r.price} ${r.currency}`, inline: true }] : []),
    ],
    ...(r.image ? { thumbnail: { url: r.image } } : {}),
    footer: { text: 'StreamShopp · Reposiciones' },
    timestamp: new Date().toISOString(),
  };
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'StreamShopp',
      embeds: [embed],
      components: [],
    }),
  });
  if (!res.ok) console.error('Discord', res.status, await res.text());
  await new Promise((s) => setTimeout(s, 1200));
}

fs.writeFileSync(STATE, JSON.stringify(now, null, 2));
console.log(`Revisados ${Object.keys(now).length} productos, ${restocks.length} avisos.`);
