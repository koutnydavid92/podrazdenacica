// POST /api/checkout - založí Stripe Checkout Session.
//   {quantity}                        - vstupenky na Číča Art Fest (hlídá kapacitu 200)
//   {product: 'onanovanky', ...}      - obchod s Onanovánkami (větev shopCheckout níže)
// Obchod žije tady, ne ve vlastním souboru: Vercel Hobby povoluje 12 funkcí a jsou plné.
const Stripe = require('stripe');
const {
    withDb, remainingPublic, unitPriceCzk, quantityDiscount, MAX_TICKETS_PER_ORDER
} = require('./_lib');
const { trackInitiateCheckout } = require('./_meta');
const shop = require('./_shop');

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

// Cookies Meta pixelu mají tvar "fb.1.<čas>.<hodnota>", u _fbc je na konci
// ID prokliku z reklamy. Pouštíme dál jen tenhle tvar a rozumnou délku.
function sanitizeFbCookie(v) {
    const s = String(v || '').trim();
    return /^fb\.[0-9]\.[0-9]{1,20}\.[A-Za-z0-9_-]{1,300}$/.test(s) ? s : null;
}

// ID, podle kterého Meta spáruje událost z prohlížeče se stejnou ze serveru.
function sanitizeEventId(v) {
    const s = String(v || '').trim();
    return /^[A-Za-z0-9_.-]{6,80}$/.test(s) ? s : null;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        // GA4 identifikátory ze stránky festu si vezmeme s sebou do Stripu,
        // ať webhook umí nákup nahlásit do analytiky i se správnou návštěvou.
        // Chybí, když kupující nedal souhlas s cookies - to je v pořádku.
        const body = await readJsonBody(req);
        if (body.product === shop.PRODUCT) {
            await shopCheckout(stripe, req, res, body);
            return;
        }
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
// Tělo: {product, quantity, shipping_method, packeta_point?, note?, ga_*, fbp, fbc, ic_event_id}
// Cenu, dopravu i tašku zdarma počítá server. Adresu a telefon vybírá Stripe
// jen tam, kde jsou potřeba (na adresu / výdejní místo).
async function shopCheckout(stripe, req, res, body) {
    const quantity = shop.clampQuantity(body.quantity);
    const methodKey = String(body.shipping_method || '');
    const method = shop.shippingMethod(methodKey);
    if (!method) {
        res.status(400).json({ error: 'bad_shipping' });
        return;
    }
    const point = method.needsPoint ? shop.sanitizePoint(body.packeta_point) : null;
    if (method.needsPoint && !point) {
        res.status(400).json({ error: 'missing_point' });
        return;
    }
    const note = String(body.note || '').replace(/\s+/g, ' ').trim().slice(0, 400);

    const stock = await withDb(shop.stockAvailable);
    if (stock <= 0) {
        res.status(409).json({ error: 'sold_out' });
        return;
    }
    if (quantity > stock) {
        res.status(409).json({ error: 'not_enough_stock', remaining: stock });
        return;
    }

    const gaClientId = sanitizeGaClientId(body.ga_client_id);
    const gaSessionId = sanitizeGaSessionId(body.ga_session_id);
    const fbp = sanitizeFbCookie(body.fbp);
    const fbc = sanitizeFbCookie(body.fbc);
    const goods = shop.goodsTotal(quantity);
    const giftBag = shop.giftBagIncluded(quantity);

    const metaEvent = trackInitiateCheckout({
        eventId: sanitizeEventId(body.ic_event_id) || 'ic_' + Date.now(),
        value: goods + method.price,
        quantity: quantity,
        fbp: fbp,
        fbc: fbc,
        eventSourceUrl: 'https://www.podrazdenacica.cz/onanovanky'
    }).catch(() => { /* měření nesmí shodit prodej */ });

    const lineItems = [{
        price_data: {
            currency: 'czk',
            unit_amount: shop.UNIT_PRICE_CZK * 100,
            product_data: {
                name: shop.PRODUCT_NAME,
                description: 'Antisystémové omalovánky pro dospělé. A4, 30 motivů, spirála nahoře. 18+.',
                images: ['https://www.podrazdenacica.cz/images/onanovanky/obalka-og.jpg']
            }
        },
        quantity: quantity
    }];
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
            quantity: String(quantity),
            shipping_method: methodKey,
            ...(point ? {
                packeta_point_id: point.id,
                packeta_point_name: point.name,
                packeta_point_address: point.address
            } : {}),
            ...(note ? { note: note } : {}),
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
        cancel_url: origin + '/onanovanky#koupit'
    };
    if (method.needsAddress) {
        params.shipping_address_collection = { allowed_countries: [method.country] };
    }

    const session = await stripe.checkout.sessions.create(params);
    await metaEvent;
    res.status(200).json({ url: session.url });
}
