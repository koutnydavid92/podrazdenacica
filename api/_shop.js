// Sdílená logika obchodu s Onanovánkami (soubory s podtržítkem Vercel
// nevystavuje jako endpointy). Ceny, doprava a dárek se počítají tady,
// na serveru - klientovi se nevěří.
//
// Endpointy: nákup je větev v api/checkout.js (položky košíku items[]),
// zaplacení řeší api/stripe-webhook.js (metadata.event === 'shop'),
// správa objednávek jsou akce shop_* v api/admin.js, opuštěné košíky
// api/_shop_carts.js. Nové soubory v api/ přidat nejde - Vercel Hobby má
// limit 12 funkcí a je plný.

const PRODUCT = 'onanovanky';
const PRODUCT_NAME = 'Onanovánky 2026';
const UNIT_PRICE_CZK = 333;
const MAX_PER_ORDER = 20;          // kusů Onanovánek na objednávku, víc jen po domluvě mailem

// Katalog (27. 10. 2026). Stejné položky a ceny má klient v onanovanky.html
// (PRODUCTS), ale platí vždycky tenhle seznam. Balíčky přibudou jako další
// položky; `components` říká, co se odečítá ze skladu (shop_stock.product ->
// kolik kusů), takže balíček se dvěma Onanovánkami odečte dva kusy.
const PRODUCTS = {
    onanovanky: {
        id: 'onanovanky',
        name: PRODUCT_NAME,
        price: UNIT_PRICE_CZK,
        description: 'Antisystémové omalovánky od Podrážděné číči. A4, 30 motivů, spirála nahoře.',
        image: 'https://www.podrazdenacica.cz/images/onanovanky/obalka-og.jpg',
        components: { onanovanky: 1 },
        active: true
    },
    // Balíčky (David 27. 10. 2026): ceny a texty z jeho zadání
    'balicek-3plus1': {
        id: 'balicek-3plus1',
        name: 'Alfasamičičí baličíček (3+1)',
        price: 999,
        description: 'Čtyři Onanovánky 2026 za cenu tří. Topovej dárek pro mámu, ségru, bestku a kolegyňku z kanclu.',
        image: 'https://www.podrazdenacica.cz/images/onanovanky/balicek-3plus1.jpg',
        components: { onanovanky: 4 },
        active: true
    },
    'balicek-5plus1': {
        id: 'balicek-5plus1',
        name: 'Ultimátní vánočiční baličíček (5+1)',
        price: 1666,
        description: 'Šest Onanovánek 2026 za cenu pěti, k tomu plátěná číča taška a doprava zdarma.',
        image: 'https://www.podrazdenacica.cz/images/onanovanky/balicek-5plus1.jpg?v=2',
        components: { onanovanky: 6 },
        freeShipping: true,        // doprava zdarma, ať si zákazník vybere cokoliv
        giftBag: true,             // plátěná číča taška v balíku
        active: true
    }
};

function product(id) {
    return Object.prototype.hasOwnProperty.call(PRODUCTS, id) && PRODUCTS[id].active ? PRODUCTS[id] : null;
}

// Položky košíku od klienta -> ověřené, sloučené podle id, s cenou z katalogu.
// Vrací null, když je něco špatně (neznámý produkt, prázdný košík).
function normalizeItems(raw) {
    const list = Array.isArray(raw) ? raw.slice(0, 20) : [];
    const byId = new Map();
    for (const it of list) {
        const id = String((it && it.id) || '').trim();
        if (!product(id)) return null;
        const qty = Math.max(0, Math.min(parseInt(it && (it.qty != null ? it.qty : it.quantity), 10) || 0, 99));
        byId.set(id, (byId.get(id) || 0) + qty);
    }
    const items = [];
    for (const [id, qty] of byId) {
        if (qty > 0) items.push({ id, name: PRODUCTS[id].name, qty, unit_price_czk: PRODUCTS[id].price });
    }
    return items.length ? items : null;
}

// Kolik kusů Onanovánek položky obsahují (limit na objednávku, statistiky, váha balíku)
function unitsOf(items) {
    return items.reduce((s, i) => s + i.qty * ((PRODUCTS[i.id] && PRODUCTS[i.id].components[PRODUCT]) || 0), 0);
}

// Co se odečte ze skladu: {onanovanky: 3, ...}
function stockNeeds(items) {
    const needs = {};
    for (const i of items) {
        const comp = (PRODUCTS[i.id] && PRODUCTS[i.id].components) || {};
        for (const k of Object.keys(comp)) needs[k] = (needs[k] || 0) + comp[k] * i.qty;
    }
    return needs;
}

function itemsTotal(items) {
    return items.reduce((s, i) => s + i.unit_price_czk * i.qty, 0);
}

// Doprava zdarma, když je v košíku položka, která ji má v ceně (balíček 5+1)
function freeShippingIncluded(items) {
    return items.some(i => PRODUCTS[i.id] && PRODUCTS[i.id].freeShipping);
}

// Co zákazník zaplatí za zvolenou dopravu při daném košíku
function shippingPriceFor(items, method) {
    return freeShippingIncluded(items) ? 0 : method.price;
}

// Do Stripe metadat (max 500 znaků na hodnotu) jde jen id a počet
function itemsForMetadata(items) {
    return JSON.stringify(items.map(i => ({ id: i.id, qty: i.qty })));
}

// Položky z metadat zaplacené pokladny. Pokladny založené před 27. 10. 2026
// mají jen quantity, ty bereme jako Onanovánky.
function itemsFromMetadata(md) {
    try {
        const items = normalizeItems(JSON.parse(md.items || ''));
        if (items) return items;
    } catch (e) { /* staré metadata bez items */ }
    return [{ id: PRODUCT, name: PRODUCT_NAME, qty: clampQuantity(md.quantity), unit_price_czk: UNIT_PRICE_CZK }];
}

// Doprava: co zákazník platí (Zásilkovna nás stojí totéž, David 5. 10. 2026),
// viz Web/Onanovánky/ceny-a-marze.md.
const SHIPPING = {
    pickup_atelier: {
        price: 0,
        label: 'Osobní odběr v ateliéru, Veselá 5, Brno',
        country: null,
        needsAddress: false,
        needsPoint: false
    },
    packeta_point_cz: {
        price: 89,
        label: 'Zásilkovna: výdejní místo nebo Z-BOX (ČR)',
        country: 'CZ',
        needsAddress: false,
        needsPoint: true
    },
    packeta_point_sk: {
        price: 129,
        label: 'Zásilkovna: výdejní místo nebo Z-BOX (SK)',
        country: 'SK',
        needsAddress: false,
        needsPoint: true
    },
    packeta_home_cz: {
        price: 129,
        label: 'Zásilkovna: doručení na adresu (ČR)',
        country: 'CZ',
        needsAddress: true,
        needsPoint: false
    },
    packeta_home_sk: {
        price: 169,
        label: 'Zásilkovna: doručení na adresu (SK)',
        country: 'SK',
        needsAddress: true,
        needsPoint: false
    }
};

function shippingMethod(key) {
    return Object.prototype.hasOwnProperty.call(SHIPPING, key) ? SHIPPING[key] : null;
}

function clampQuantity(v) {
    const q = parseInt(v, 10) || 1;
    return Math.max(1, Math.min(q, MAX_PER_ORDER));
}

function goodsTotal(quantity) {
    return UNIT_PRICE_CZK * clampQuantity(quantity);
}

// Plátěná taška jde jen s položkou, která ji má v ceně (balíček 5+1).
// Dřívější pravidlo „od 999 Kč za zboží“ David 27. 10. 2026 zrušil.
function giftBagIncluded(items) {
    return Array.isArray(items) && items.some(i => PRODUCTS[i.id] && PRODUCTS[i.id].giftBag);
}

// E-mail z košíku: malá písmena, rozumná délka a tvar
function sanitizeEmail(v) {
    const s = String(v || '').trim().toLowerCase().slice(0, 200);
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

// Výdejní místo z widgetu Zásilkovny: bereme jen hodnoty v rozumném tvaru
// a délce. ID je číslo (interní místa) nebo číslo dopravce.
function sanitizePoint(p) {
    if (!p || typeof p !== 'object') return null;
    const id = String(p.id || '').trim();
    if (!/^[0-9]{1,12}$/.test(id)) return null;
    const clip = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const name = clip(p.name, 120);
    if (!name) return null;
    const address = clip(p.address || [p.street, p.zip, p.city].filter(Boolean).join(', '), 200);
    const country = /^(cz|sk)$/i.test(String(p.country || '')) ? String(p.country).toLowerCase() : null;
    return country ? { id, name, address, country } : { id, name, address };
}

// Kolik kusů je skladem (online prodej)
async function stockAvailable(client, key = PRODUCT) {
    const { rows } = await client.query(
        'select stock from shop_stock where product = $1', [key]);
    return rows.length ? rows[0].stock : 0;
}

// Chybí něco ze skladu pro dané potřeby? Vrací null, nebo {key, remaining}.
async function stockShortage(client, needs) {
    for (const key of Object.keys(needs)) {
        const remaining = await stockAvailable(client, key);
        if (needs[key] > remaining) return { key, remaining };
    }
    return null;
}

// Zapíše zaplacenou objednávku a odečte sklad. Idempotentní: když už pro
// session objednávka existuje (webhook přišel dvakrát), nic dalšího nevznikne.
// Vrací {created, already, orderNo, orderId, items, quantity}.
async function fulfillShopSession(client, session) {
    const { rows: existing } = await client.query(
        'select id from shop_orders where stripe_session_id = $1', [session.id]);
    if (existing.length) return { created: 0, already: true };

    const md = session.metadata || {};
    const items = itemsFromMetadata(md);
    const q = Math.max(1, Math.min(unitsOf(items) || 1, MAX_PER_ORDER)); // kusů Onanovánek
    const goods = itemsTotal(items);
    const method = shippingMethod(md.shipping_method) || SHIPPING.pickup_atelier;
    const details = session.customer_details || {};
    const addr = (session.shipping_details && session.shipping_details.address)
        || (session.collected_information && session.collected_information.shipping_details
            && session.collected_information.shipping_details.address)
        || null;
    const shippingName = (session.shipping_details && session.shipping_details.name)
        || (session.collected_information && session.collected_information.shipping_details
            && session.collected_information.shipping_details.name)
        || null;
    const total = session.amount_total ? Math.round(session.amount_total / 100) : 0;

    await client.query('begin');
    let order;
    try {
        const { rows } = await client.query(
            `insert into shop_orders (
                stripe_session_id, stripe_payment_intent, product, quantity, unit_price_czk,
                shipping_method, shipping_price_czk, total_czk, gift_bag,
                name, email, phone,
                address_line1, address_line2, address_city, address_zip, address_country,
                packeta_point_id, packeta_point_name, packeta_point_address,
                note, ga_client_id, ga_session_id, items)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
             returning id, order_no`,
            [
                session.id,
                typeof session.payment_intent === 'string' ? session.payment_intent : null,
                PRODUCT, q, UNIT_PRICE_CZK,
                md.shipping_method || 'pickup_atelier', shippingPriceFor(items, method), total, giftBagIncluded(items),
                shippingName || details.name || null,
                details.email || null,
                details.phone || null,
                addr ? addr.line1 : null,
                addr ? addr.line2 : null,
                addr ? addr.city : null,
                addr ? addr.postal_code : null,
                addr ? addr.country : null,
                md.packeta_point_id || null,
                md.packeta_point_name || null,
                md.packeta_point_address || null,
                md.note || null,
                md.ga_client_id || null,
                md.ga_session_id || null,
                JSON.stringify(items)
            ]);
        order = rows[0];
        const needs = stockNeeds(items);
        for (const key of Object.keys(needs)) {
            await client.query(
                `update shop_stock set stock = greatest(stock - $2, 0), sold = sold + $2, updated_at = now()
                 where product = $1`, [key, needs[key]]);
        }
        await client.query('commit');
    } catch (e) {
        await client.query('rollback');
        throw e;
    }

    // Opuštěné košíky: tenhle (z metadat) i další otevřené se stejným e-mailem
    // jsou zaplacené, žádná připomínka. Nesmí shodit vyřízení objednávky.
    try {
        const carts = require('./_shop_carts');
        await carts.markCartsPaid(client, { cartId: md.cart_id, email: details.email, orderId: order.id });
    } catch (e) {
        console.error('cart mark paid failed', session.id, e.message);
    }
    return { created: 1, already: false, orderNo: order.order_no, orderId: order.id, items, quantity: q };
}


// Heureka „Ověřeno zákazníky“: po zaplacení nahlásíme objednávku (e-mail +
// ITEM_ID z feedu), Heureka pošle zákazníkovi dotazník spokojenosti. Volá se jen
// když zákazník v objednávce dotazník neodmítl. Nikdy nesmí shodit vyřízení.
const HEUREKA_ITEM_ID = 'onanovanky-2026';
async function logHeurekaOrder({ email, orderNo }) {
    const apiKey = process.env.HEUREKA_OVERENO_KEY;
    if (!apiKey || !email) return { skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const res = await fetch('https://api.heureka.cz/shop-certification/v2/order/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=utf-8' },
            body: JSON.stringify({ apiKey, email, orderId: orderNo, productItemIds: [HEUREKA_ITEM_ID] }),
            signal: controller.signal
        });
        const text = await res.text();
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));
        return { ok: true };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    PRODUCT, PRODUCT_NAME, UNIT_PRICE_CZK, MAX_PER_ORDER, SHIPPING, PRODUCTS,
    product, normalizeItems, unitsOf, stockNeeds, itemsTotal, itemsForMetadata, itemsFromMetadata,
    freeShippingIncluded, shippingPriceFor,
    shippingMethod, clampQuantity, goodsTotal, giftBagIncluded, sanitizeEmail, sanitizePoint,
    stockAvailable, stockShortage, fulfillShopSession, logHeurekaOrder
};
