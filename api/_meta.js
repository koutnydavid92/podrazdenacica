// Serverové měření nákupu do Mety (Conversions API).
//
// Proč vůbec: Meta Pixel hlásí nákup až z děkovací stránky. Kdo po zaplacení
// zavře záložku a nevrátí se ze Stripu zpátky (na mobilu běžné), toho nákup
// Meta nikdy nezaznamená a nemá podle čeho optimalizovat cílení reklam.
// Webhook o zaplacení ví vždycky, takže nákup pošleme i odsud.
//
// Duplicity: pixel i tenhle kód posílají stejné event_id (Stripe session).
// Meta si podle něj obě zprávy spáruje a započítá nákup jen jednou.
//
// Atribuce: ze stránky festu si do Stripe metadat schováme cookies _fbp a _fbc.
// _fbc nese ID prokliku z reklamy (fbclid), takže Meta pozná, která reklama
// nákup přinesla. Obě cookies zakládá pixel bez ohledu na souhlas s cookies,
// takže na rozdíl od GA4 dorazí skoro vždycky.

const crypto = require('crypto');

const PIXEL_ID = '1303482295051535';
const API_VERSION = 'v21.0';

// E-mail se posílá jen jako otisk (SHA-256), Meta ho v čitelné podobě nedostane.
function hashEmail(email) {
    const s = String(email || '').trim().toLowerCase();
    if (!s || !s.includes('@')) return null;
    return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Pošle do Mety událost Purchase. Nikdy nevyhodí výjimku ani nezdrží
 * vyřízení objednávky - měření nesmí shodit prodej vstupenek.
 *
 * @param {object} o
 * @param {string} o.transactionId  Stripe session id (= eventID pixelu, kvůli párování)
 * @param {number} o.value          skutečně zaplaceno v Kč (po slevách)
 * @param {number} o.quantity       počet vstupenek
 * @param {string|null} o.fbp       cookie _fbp, když je
 * @param {string|null} o.fbc       cookie _fbc (proklik z reklamy), když je
 * @param {string|null} o.email     e-mail kupujícího (pošle se jen jako otisk)
 * @param {string} [o.eventSourceUrl] stránka, kde nákup vznikl
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function trackPurchase(o) {
    const token = process.env.META_CAPI_TOKEN;
    if (!token) {
        console.warn('Meta CAPI: chybí META_CAPI_TOKEN, nákup se do Mety neposílá');
        return { sent: false, reason: 'no_token' };
    }

    const quantity = Number(o.quantity) || 1;
    const value = Number(o.value) || 0;

    // Meta zprávu bez jediného identifikátoru odmítne. Když nemáme ani cookies,
    // ani e-mail, nemá smysl posílat nic - stejně by to nešlo k nikomu přiřadit.
    const emailHash = hashEmail(o.email);
    const userData = {};
    if (o.fbp) userData.fbp = String(o.fbp);
    if (o.fbc) userData.fbc = String(o.fbc);
    if (emailHash) userData.em = [emailHash];
    if (!Object.keys(userData).length) {
        console.warn('Meta CAPI: nákup', o.transactionId, 'nemá žádný identifikátor, neposílám');
        return { sent: false, reason: 'no_identifiers' };
    }

    const payload = {
        data: [{
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            // Stejné ID jako u pixelu -> Meta nákup nezapočítá dvakrát
            event_id: o.transactionId,
            event_source_url: o.eventSourceUrl || 'https://www.podrazdenacica.cz/cica-art-fest',
            action_source: 'website',
            user_data: userData,
            custom_data: {
                value: value,
                currency: 'CZK',
                content_type: 'product',
                content_name: 'Vstupenka Cica Art Fest',
                contents: [{
                    id: 'cica-art-fest-vstupenka',
                    quantity: quantity
                }]
            }
        }]
    };
    // Testovací režim: události se v Events Manageru ukážou v "Test events"
    // a nezapočítají se do ostrých dat. Nastavuje se jen dočasně při ladění.
    if (process.env.META_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`
        + `?access_token=${encodeURIComponent(token)}`;

    try {
        // Časový strop, ať se webhook nezasekne, kdyby Meta neodpovídala
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 4000);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: abort.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            console.error('Meta CAPI: Purchase neodeslán, HTTP', res.status, detail.slice(0, 300));
            return { sent: false, reason: 'http_' + res.status };
        }
        console.log('Meta CAPI: Purchase odeslán', o.transactionId, value, 'CZK',
            '| fbp:', o.fbp ? 'ano' : 'ne', '| fbc:', o.fbc ? 'ano' : 'ne',
            '| e-mail:', emailHash ? 'ano' : 'ne');
        return { sent: true };
    } catch (e) {
        console.error('Meta CAPI: Purchase neodeslán:', e.message);
        return { sent: false, reason: 'exception' };
    }
}

module.exports = { trackPurchase };
