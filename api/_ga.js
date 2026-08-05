// Serverové měření nákupu do GA4 (Measurement Protocol).
//
// Proč vůbec: klientský gtag na děkovací stránce se spustí jen když kupující
// odsouhlasil cookies A vrátil se ze Stripu zpátky na web. Obojí často neplatí,
// takže reálné nákupy do GA4 nedorazily. Webhook o platbě ví vždycky.
//
// Atribuce: ze stránky festu si do Stripe metadat schováme GA4 client_id
// a session_id (z cookies _ga a _ga_<měřicí ID>). Díky nim událost dosedne
// do skutečné návštěvy toho člověka i se zdrojem návštěvnosti.
// Když souhlas s cookies nepadl, žádné cookies neexistují a posíláme
// jednorázové náhodné client_id: tržba v GA4 sedí, ale nikoho nesledujeme.

const crypto = require('crypto');

const MEASUREMENT_ID = 'G-R06FFJPHLK';
const ENDPOINT = 'https://www.google-analytics.com/mp/collect';

// Náhradní client_id pro kupující bez souhlasu s cookies.
// Formát odpovídá GA4 (<číslo>.<čas>), ale nikde se neukládá,
// takže ho nejde spojit s žádnou další návštěvou ani zařízením.
function anonymousClientId() {
    const rand = crypto.randomInt(1e8, 1e9);
    return `${rand}.${Math.floor(Date.now() / 1000)}`;
}

/**
 * Pošle do GA4 událost purchase. Nikdy nevyhodí výjimku ani nezdrží
 * vyřízení objednávky - měření nesmí shodit prodej vstupenek.
 *
 * @param {object} o
 * @param {string} o.transactionId  Stripe session id (stejné jako na klientovi -> GA4 si poradí s duplicitou)
 * @param {number} o.value          skutečně zaplaceno v Kč (po slevách)
 * @param {number} o.quantity       počet vstupenek
 * @param {string|null} o.clientId  GA4 client_id z cookie _ga, když je
 * @param {string|null} o.sessionId GA4 session_id z cookie _ga_<ID>, když je
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function trackPurchase(o) {
    const apiSecret = process.env.GA4_API_SECRET;
    if (!apiSecret) {
        console.warn('GA4: chybí GA4_API_SECRET, nákup se do analytiky neposílá');
        return { sent: false, reason: 'no_api_secret' };
    }

    const quantity = Number(o.quantity) || 1;
    const value = Number(o.value) || 0;
    const unit = quantity ? Math.round((value / quantity) * 100) / 100 : value;

    const params = {
        transaction_id: o.transactionId,
        value: value,
        currency: 'CZK',
        tickets: quantity,
        items: [{
            item_id: 'cica-art-fest-vstupenka',
            item_name: 'Vstupenka Číča Art Fest',
            price: unit,
            quantity: quantity
        }],
        // GA4 bez tohohle parametru událost do standardních přehledů nepustí
        engagement_time_msec: 1
    };
    // Se session_id událost dosedne do existující návštěvy i s jejím zdrojem.
    // Bez něj GA4 založí novou návštěvu a nákup spadne pod (direct).
    if (o.sessionId) params.session_id = String(o.sessionId);

    const body = {
        client_id: o.clientId || anonymousClientId(),
        non_personalized_ads: true,
        events: [{ name: 'purchase', params }]
    };

    const url = `${ENDPOINT}?measurement_id=${MEASUREMENT_ID}`
        + `&api_secret=${encodeURIComponent(apiSecret)}`;

    try {
        // Časový strop, ať se webhook nezasekne, kdyby Google neodpovídal
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 4000);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: abort.signal
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            console.error('GA4: purchase neodeslán, HTTP', res.status);
            return { sent: false, reason: `http_${res.status}` };
        }
        console.log('GA4: purchase odeslán', o.transactionId, value, 'CZK',
            o.clientId ? '(se souhlasem)' : '(anonymně)');
        return { sent: true };
    } catch (e) {
        console.error('GA4: purchase neodeslán:', e.message);
        return { sent: false, reason: 'request_failed' };
    }
}

module.exports = { trackPurchase };
