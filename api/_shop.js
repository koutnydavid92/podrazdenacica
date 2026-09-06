// Sdílená logika obchodu s Onanovánkami (soubory s podtržítkem Vercel
// nevystavuje jako endpointy). Ceny, doprava a dárek se počítají tady,
// na serveru - klientovi se nevěří.
//
// Endpointy: nákup je větev v api/checkout.js (product: 'onanovanky'),
// zaplacení řeší api/stripe-webhook.js (metadata.event === 'shop'),
// správa objednávek jsou akce shop_* v api/admin.js. Nové soubory
// v api/ přidat nejde - Vercel Hobby má limit 12 funkcí a je plný.

const PRODUCT = 'onanovanky';
const PRODUCT_NAME = 'Onanovánky 2026';
const UNIT_PRICE_CZK = 333;
const MAX_PER_ORDER = 20;          // víc kusů jen po domluvě mailem
const GIFT_BAG_FROM_CZK = 999;     // od téhle částky za zboží je taška zdarma

// Doprava: co zákazník platí. Zásilkovna nám účtuje smluvní ceník
// (cca 70 až 80 Kč do ČR na výdejní místo), viz Web/Onanovánky/ceny-a-marze.md.
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

function giftBagIncluded(quantity) {
    return goodsTotal(quantity) >= GIFT_BAG_FROM_CZK;
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
    const address = clip([p.street, p.zip, p.city].filter(Boolean).join(', '), 200);
    return { id, name, address };
}

// Kolik kusů je skladem (online prodej)
async function stockAvailable(client) {
    const { rows } = await client.query(
        'select stock from shop_stock where product = $1', [PRODUCT]);
    return rows.length ? rows[0].stock : 0;
}

// Zapíše zaplacenou objednávku a odečte sklad. Idempotentní: když už pro
// session objednávka existuje (webhook přišel dvakrát), nic dalšího nevznikne.
async function fulfillShopSession(client, session, quantity) {
    const { rows: existing } = await client.query(
        'select id from shop_orders where stripe_session_id = $1', [session.id]);
    if (existing.length) return { created: 0, already: true };

    const md = session.metadata || {};
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
    const q = clampQuantity(quantity);

    await client.query('begin');
    try {
        const { rows } = await client.query(
            `insert into shop_orders (
                stripe_session_id, stripe_payment_intent, product, quantity, unit_price_czk,
                shipping_method, shipping_price_czk, total_czk, gift_bag,
                name, email, phone,
                address_line1, address_line2, address_city, address_zip, address_country,
                packeta_point_id, packeta_point_name, packeta_point_address,
                note, ga_client_id, ga_session_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             returning order_no`,
            [
                session.id,
                typeof session.payment_intent === 'string' ? session.payment_intent : null,
                PRODUCT, q, UNIT_PRICE_CZK,
                md.shipping_method || 'pickup_atelier', method.price, total, giftBagIncluded(q),
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
                md.ga_session_id || null
            ]);
        await client.query(
            `update shop_stock set stock = greatest(stock - $2, 0), sold = sold + $2, updated_at = now()
             where product = $1`, [PRODUCT, q]);
        await client.query('commit');
        return { created: 1, already: false, orderNo: rows[0].order_no };
    } catch (e) {
        await client.query('rollback');
        throw e;
    }
}

module.exports = {
    PRODUCT, PRODUCT_NAME, UNIT_PRICE_CZK, MAX_PER_ORDER, GIFT_BAG_FROM_CZK, SHIPPING,
    shippingMethod, clampQuantity, goodsTotal, giftBagIncluded, sanitizePoint,
    stockAvailable, fulfillShopSession
};
