// POST /api/checkout - založí Stripe Checkout Session pro nákup vstupenek.
// Hlídá kapacitu (200 veřejných vstupenek) ještě před přesměrováním na platbu.
const Stripe = require('stripe');
const { withDb, remainingPublic, currentPriceCzk } = require('./_lib');
const { trackInitiateCheckout } = require('./_meta');

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

        // Zahájení nákupu do Mety. Hlásí ho server, protože pixel v prohlížeči
        // se načítá odloženě a blokují ho adblockery - klientská událost se tak
        // často ztratí. Stejné event_id jako v prohlížeči, Meta si je spáruje.
        // Nečekáme na odpověď, ať se kupujícímu neprodlouží cesta do pokladny.
        trackInitiateCheckout({
            eventId: sanitizeEventId(body.ic_event_id) || 'ic_' + Date.now(),
            value: currentPriceCzk(),
            quantity: 1,
            fbp: fbp,
            fbc: fbc
        }).catch(() => {});

        const origin = req.headers.origin || 'https://www.podrazdenacica.cz';
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            locale: 'cs',
            line_items: [{
                price_data: {
                    currency: 'czk',
                    unit_amount: currentPriceCzk() * 100,
                    product_data: {
                        name: 'Vstupenka na Číča Art Fest',
                        description: '28. 8. 2026 · co.labs_park, Brno. Vstupenka s QR kódem dorazí na mail.'
                    }
                },
                quantity: 1,
                adjustable_quantity: {
                    enabled: true,
                    minimum: 1,
                    maximum: Math.min(6, remaining)
                }
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

        res.status(200).json({ url: session.url });
    } catch (e) {
        console.error('checkout error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
