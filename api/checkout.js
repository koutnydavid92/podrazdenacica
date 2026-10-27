// POST /api/checkout - založí Stripe Checkout Session.
//   {quantity}                                  - vstupenky na Číča Art Fest (hlídá kapacitu 200)
//   {items:[{id,qty}], shipping_method, ...}    - obchod s Onanovánkami (větev shopCheckout níže)
//   {product:'onanovanky', quantity, ...}       - starší stránka obchodu (do 27. 10. 2026), totéž
//   {cart_save:{...}}                           - uložení košíku s e-mailem (opuštěné košíky)
//   {cart_stop:'<token>'}                       - zrušení připomínek z odkazu v mailu
//   {track:'view_content'|'add_to_cart', ...}   - serverové události do Mety
// Obchod žije tady, ne ve vlastním souboru: Vercel Hobby povoluje 12 funkcí a jsou plné.
const Stripe = require('stripe');
const {
    withDb, remainingPublic, unitPriceCzk, quantityDiscount, MAX_TICKETS_PER_ORDER
} = require('./_lib');
const {
    trackInitiateCheckout, trackViewContent, trackAddToCart, sanitizeFbCookie, sanitizeEventId
} = require('./_meta');
const { trackBeginCheckout } = require('./_ga');
const { clientIp } = require('./_lib');
const shop = require('./_shop');
const carts = require('./_shop_carts');

// Tělo requestu: Vercel ho obvykle naparsuje sám, ale request bez těla
// nebo bez hlavičky Content-Type sem dorazí jako undefined nebo jako řetězec.
async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string' && req.body) {
        try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
    return {};
}

// Do Stripe metadat pustíme jen přesný tvar, jaký GA4 používá.
// client_id z cookie _ga vypadá jako "1234567890.1712345678",
// session_id z cookie _ga_<měřicí ID> je holé číslo "1712345678".
function sanitizeGaClientId(v) {
    const s = String(v || '').trim();
    return /^[0-9]{1,20}\.[0-9]{1,20}$/.test(s) ? s : null;
}

function sanitizeGaSessionId(v) {
    const s = String(v || '').trim();
    return /^[0-9]{1,20}$/.test(s) ? s : null;
}

// Adresa stránky pro Metu: jen náš web, jinak výchozí stránka obchodu
function safeSourceUrl(v) {
    return /^https:\/\/(www\.)?podrazdenacica\.cz\/[A-Za-z0-9\/_.-]*$/.test(String(v || ''))
        ? v : 'https://www.podrazdenacica.cz/onanovanky';
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    try {
        const body = await readJsonBody(req);

        // Měření zobrazení stránky do Mety ze serveru (viz trackViewContent).
        // Žije tady kvůli limitu 12 funkcí; se Stripem nemá nic společného.
        if (body.track === 'view_content') {
            await trackViewContent({
                eventId: sanitizeEventId(body.event_id) || 'vc_' + Date.now(),
                fbp: sanitizeFbCookie(body.fbp),
                fbc: sanitizeFbCookie(body.fbc),
                clientIp: clientIp(req),
                userAgent: req.headers['user-agent'] || '',
                eventSourceUrl: safeSourceUrl(body.url),
                contentName: 'Onanovanky 2026',
                contentId: 'onanovanky',
                value: shop.UNIT_PRICE_CZK
            }).catch(() => {});
            res.status(204).end();
            return;
        }

        // Přidání do košíku do Mety ze serveru (stejné event_id jako pixel)
        if (body.track === 'add_to_cart') {
            const items = shop.normalizeItems(body.items) || [];
            await trackAddToCart({
                eventId: sanitizeEventId(body.event_id) || 'atc_' + Date.now(),
                fbp: sanitizeFbCookie(body.fbp),
                fbc: sanitizeFbCookie(body.fbc),
                clientIp: clientIp(req),
                userAgent: req.headers['user-agent'] || '',
                eventSourceUrl: safeSourceUrl(body.url),
                contents: items.map(i => ({ id: i.id, quantity: i.qty, item_price: i.unit_price_czk })),
                value: shop.itemsTotal(items)
            }).catch(() => {});
            res.status(204).end();
            return;
        }

        if (body.cart_save) {
            await cartSave(req, res, body);
            return;
        }
        if (body.cart_stop) {
            const out = await withDb(c => carts.stopCart(c, body.cart_stop));
            res.status(out.ok ? 200 : 400).json(out);
            return;
        }

        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        if (body.product === shop.PRODUCT || Array.isArray(body.items)) {
            await shopCheckout(stripe, req, res, body);
            return;
        }

        // GA4 identifikátory ze stránky festu si vezmeme s sebou do Stripu,
        // ať webhook umí nákup nahlásit do analytiky i se správnou návštěvou.
        // Chybí, když kupující nedal souhlas s cookies - to je v pořádku.
        const gaClientId = sanitizeGaClientId(body.ga_client_id);
        const gaSessionId = sanitizeGaSessionId(body.ga_session_id);
        // Totéž pro Metu: _fbp drží prohlížeč, _fbc proklik z reklamy.
        // Díky nim webhook nahlásí nákup i reklamě, která ho přinesla.
        const fbp = sanitizeFbCookie(body.fbp);
        const fbc = sanitizeFbCookie(body.fbc);

        const remaining = await withDb(remainingPublic);
        if (remaining <= 0) {
            res.status(409).json({ error: 'sold_out' });
            return;
        }

        // Kolik vstupenek si zvolil na webu. Od dvou kusů platí množstevní
        // sleva, cenu za kus proto počítáme tady - klientovi se nevěří.
        const wanted = parseInt(body.quantity, 10) || 1;
        if (wanted > remaining) {
            res.status(409).json({ error: 'not_enough_tickets', remaining });
            return;
        }
        const quantity = Math.max(1, Math.min(wanted, MAX_TICKETS_PER_ORDER));
        const unit = unitPriceCzk(quantity);
        const discount = quantityDiscount(quantity);

        // Zahájení nákupu do Mety. Hlásí ho server, protože pixel v prohlížeči
        // se načítá odloženě a blokují ho adblockery - klientská událost se tak
        // často ztratí. Stejné event_id jako v prohlížeči, Meta si je spáruje.
        //
        // Pouštíme to souběžně se zakládáním platby a před odpovědí na obojí
        // počkáme. Nedokončený požadavek by se totiž mohl ztratit ve chvíli,
        // kdy serverless funkce po odeslání odpovědi skončí. Čekání nákup
        // nezdrží: Meta odpoví dřív, než je hotová Stripe session.
        const metaEvent = trackInitiateCheckout({
            eventId: sanitizeEventId(body.ic_event_id) || 'ic_' + Date.now(),
            value: unit * quantity,
            quantity: quantity,
            fbp: fbp,
            fbc: fbc
        }).catch(() => { /* měření nesmí shodit prodej */ });

        const origin = req.headers.origin || 'https://www.podrazdenacica.cz';
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            locale: 'cs',
            line_items: [{
                price_data: {
                    currency: 'czk',
                    unit_amount: unit * 100,
                    product_data: {
                        name: 'Vstupenka na Číča Art Fest',
                        description: '28. 8. 2026 · co.labs_park, Brno. Vstupenka s QR kódem dorazí na mail.'
                            + (discount ? ` Množstevní sleva ${Math.round(discount * 100)} %.` : '')
                    }
                },
                quantity: quantity
            }],
            metadata: {
                event: 'cica-art-fest',
                ...(gaClientId ? { ga_client_id: gaClientId } : {}),
                ...(gaSessionId ? { ga_session_id: gaSessionId } : {}),
                ...(fbp ? { fbp: fbp } : {}),
                ...(fbc ? { fbc: fbc } : {})
            },
            allow_promotion_codes: true,
            success_url: origin + '/cica-art-fest/dekuji?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: origin + '/cica-art-fest#vstupenky'
        });

        // Odpovíme až po doručení události do Mety (viz komentář výše).
        await metaEvent;

        res.status(200).json({ url: session.url });
    } catch (e) {
        console.error('checkout error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};

// ---- Obchod: Onanovánky ----

// Společná příprava košíku z těla requestu: ověřené položky, doprava, místo,
// vzkaz, e-mail. Vrací {error} nebo data.
function readCart(src) {
    const items = shop.normalizeItems(Array.isArray(src.items) ? src.items
        : [{ id: shop.PRODUCT, qty: src.quantity }]);
    if (!items) return { error: 'bad_items' };
    if (shop.unitsOf(items) > shop.MAX_PER_ORDER) return { error: 'too_many' };
    const methodKey = String(src.shipping_method || '');
    const method = shop.shippingMethod(methodKey);
    if (!method) return { error: 'bad_shipping' };
    const point = shop.sanitizePoint(src.packeta_point);
    return {
        items, methodKey, method, point,
        note: String(src.note || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        email: shop.sanitizeEmail(src.email)
    };
}

// Uložení košíku s e-mailem pro připomínky (viz api/_shop_carts.js).
async function cartSave(req, res, body) {
    const cartData = readCart(body.cart_save || {});
    if (cartData.error || !cartData.email) {
        res.status(400).json({ error: cartData.error || 'bad_email' });
        return;
    }
    const goods = shop.itemsTotal(cartData.items);
    const saved = await withDb(c => carts.upsertCart(c, {
        token: (body.cart_save || {}).token,
        email: cartData.email,
        items: cartData.items,
        shipping_method: cartData.methodKey,
        packeta_point: cartData.point,
        note: cartData.note,
        goods_czk: goods,
        shipping_czk: cartData.method.price,
        total_czk: goods + cartData.method.price,
        ga_client_id: sanitizeGaClientId(body.ga_client_id),
        ga_session_id: sanitizeGaSessionId(body.ga_session_id),
        fbp: sanitizeFbCookie(body.fbp),
        fbc: sanitizeFbCookie(body.fbc),
        ip: clientIp(req),
        user_agent: req.headers['user-agent'] || '',
        checkout_started: false
    }));
    res.status(200).json({ token: saved.token });
}

// Tělo: {items:[{id,qty}], shipping_method, packeta_point?, note?, email?, heureka_optout?,
//        cart_token?, ga_*, fbp, fbc, ic_event_id}
// Cenu, dopravu i tašku zdarma počítá server. Jméno, telefon a adresu vybírá
// Stripe jen tam, kde jsou potřeba (na adresu / výdejní místo).
async function shopCheckout(stripe, req, res, body) {
    const cartData = readCart(body);
    if (cartData.error) {
        res.status(400).json({ error: cartData.error });
        return;
    }
    const { items, methodKey, method, point, note, email } = cartData;
    if (method.needsPoint && !point) {
        res.status(400).json({ error: 'missing_point' });
        return;
    }
    // Heureka Ověřeno zákazníky: zákazník může dotazník odmítnout zaškrtnutím v objednávce
    const heurekaOptOut = body.heureka_optout === true || body.heureka_optout === '1';
    const units = shop.unitsOf(items);
    const goods = shop.itemsTotal(items);
    const giftBag = shop.giftBagIncluded(goods);
    const gaClientId = sanitizeGaClientId(body.ga_client_id);
    const gaSessionId = sanitizeGaSessionId(body.ga_session_id);
    const fbp = sanitizeFbCookie(body.fbp);
    const fbc = sanitizeFbCookie(body.fbc);

    // Sklad a uložení košíku v jednom připojení k databázi
    let shortage = null;
    let savedCart = null;
    await withDb(async (c) => {
        shortage = await shop.stockShortage(c, shop.stockNeeds(items));
        if (shortage || !email) return;
        try {
            savedCart = await carts.upsertCart(c, {
                token: body.cart_token,
                email, items,
                shipping_method: methodKey,
                packeta_point: point,
                note,
                goods_czk: goods,
                shipping_czk: method.price,
                total_czk: goods + method.price,
                ga_client_id: gaClientId, ga_session_id: gaSessionId, fbp, fbc,
                ip: clientIp(req),
                user_agent: req.headers['user-agent'] || '',
                checkout_started: true
            });
        } catch (e) {
            console.error('cart save failed', e.message); // košík nesmí zastavit platbu
        }
    });
    if (shortage) {
        if (shortage.remaining <= 0) res.status(409).json({ error: 'sold_out' });
        else res.status(409).json({ error: 'not_enough_stock', remaining: shortage.remaining });
        return;
    }

    const metaEvent = trackInitiateCheckout({
        eventId: sanitizeEventId(body.ic_event_id) || 'ic_' + Date.now(),
        value: goods + method.price,
        quantity: units,
        fbp: fbp,
        fbc: fbc,
        email: email,
        eventSourceUrl: 'https://www.podrazdenacica.cz/onanovanky'
    }).catch(() => { /* měření nesmí shodit prodej */ });

    // Zahájení objednávky do GA4 (a přes GA4 do Google Ads). Běží souběžně
    // se zakládáním platby ve Stripu, takže cestu k platbě nezdržuje.
    const gaEvent = trackBeginCheckout({
        value: goods + method.price,
        quantity: units,
        clientId: gaClientId,
        sessionId: gaSessionId
    }).catch(() => { /* měření nesmí shodit prodej */ });

    const lineItems = items.map(i => {
        const p = shop.product(i.id);
        return {
            price_data: {
                currency: 'czk',
                unit_amount: i.unit_price_czk * 100,
                product_data: {
                    name: i.name,
                    description: p.description,
                    images: p.image ? [p.image] : undefined
                }
            },
            quantity: i.qty
        };
    });
    if (giftBag) {
        lineItems.push({
            price_data: {
                currency: 'czk',
                unit_amount: 0,
                product_data: {
                    name: 'Plátěná číča taška (dárek)',
                    description: 'K nákupu od ' + shop.GIFT_BAG_FROM_CZK + ' Kč zdarma.'
                }
            },
            quantity: 1
        });
    }
    if (method.price > 0) {
        lineItems.push({
            price_data: {
                currency: 'czk',
                unit_amount: method.price * 100,
                product_data: {
                    name: 'Doprava: ' + method.label,
                    description: point ? point.name + (point.address ? ', ' + point.address : '') : undefined
                }
            },
            quantity: 1
        });
    }

    const origin = req.headers.origin || 'https://www.podrazdenacica.cz';
    const params = {
        mode: 'payment',
        locale: 'cs',
        line_items: lineItems,
        metadata: {
            event: 'shop',
            product: shop.PRODUCT,
            quantity: String(units),
            items: shop.itemsForMetadata(items),
            shipping_method: methodKey,
            ...(savedCart ? { cart_id: savedCart.id } : {}),
            ...(point ? {
                packeta_point_id: point.id,
                packeta_point_name: point.name,
                packeta_point_address: point.address
            } : {}),
            ...(note ? { note: note } : {}),
            ...(heurekaOptOut ? { heureka_optout: '1' } : {}),
            ...(gaClientId ? { ga_client_id: gaClientId } : {}),
            ...(gaSessionId ? { ga_session_id: gaSessionId } : {}),
            ...(fbp ? { fbp: fbp } : {}),
            ...(fbc ? { fbc: fbc } : {})
        },
        // Telefon chce Zásilkovna kvůli SMS o doručení; u odběru v ateliéru
        // se hodí pro domluvu, ale nevynucujeme ho.
        phone_number_collection: { enabled: method.needsPoint || method.needsAddress },
        custom_text: {
            submit: {
                message: method.needsAddress || method.needsPoint
                    ? 'Balíme do 3 pracovních dnů. Zaplacením souhlasíš s obchodními podmínkami na podrazdenacica.cz/obchodni-podminky.'
                    : 'Po zaplacení ti napíšeme, kdy si můžeš pro Onanovánky přijít na Veselou 5. Zaplacením souhlasíš s obchodními podmínkami na podrazdenacica.cz/obchodni-podminky.'
            }
        },
        allow_promotion_codes: true,
        success_url: origin + '/onanovanky-dekuji?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: origin + '/onanovanky#kosik'
    };
    // E-mail z košíku předvyplníme do pokladny (Stripe ho pak nenechá měnit),
    // takže potvrzení i případná připomínka jdou na stejnou adresu.
    if (email) params.customer_email = email;
    if (method.needsAddress) {
        params.shipping_address_collection = { allowed_countries: [method.country] };
    }

    const session = await stripe.checkout.sessions.create(params);
    await metaEvent;
    await gaEvent;
    res.status(200).json({ url: session.url, cart_token: savedCart ? savedCart.token : null });
}
