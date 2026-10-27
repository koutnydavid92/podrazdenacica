// Opuštěné košíky Onanovánek (soubor s podtržítkem, Vercel ho nevystavuje).
//
// Jak to funguje: košík v prohlížeči si pamatuje localStorage. Jakmile člověk
// v panelu košíku zadá e-mail (nebo klikne na Zaplatit), /api/checkout košík
// uloží sem (tabulka shop_carts, token je neuhodnutelný odkaz pro obnovu).
// Zaplacení ho uzavře (webhook, markCartsPaid). Kdo nezaplatí, dostane
// připomínku 3 hodiny po poslední změně a druhou po 24 hodinách, bez slevy
// (rozhodnutí Davida 27. 10. 2026). Odkaz „Zrušit připomínky“ v mailu nastaví
// stav unsubscribed a ten drží i pro další košíky se stejným e-mailem.
//
// Spouštění připomínek: api/program-mail-followup.js?job=cart-reminders
// (volá pg_cron v Supabase každých 15 minut, Vercel Hobby umí cron jen 1× denně).
const crypto = require('crypto');
const { sendShopCartReminderEmail } = require('./_email');

const TOKEN_RE = /^[A-Za-z0-9_-]{16,48}$/;
const REMINDER_1_AFTER = '180 minutes';   // od poslední změny košíku
const REMINDER_2_AFTER = '21 hours';      // od první připomínky (tj. cca 24 h od opuštění)
const EXPIRE_AFTER = '14 days';
const MAX_PER_RUN = 50;

function newToken() {
    return crypto.randomBytes(18).toString('base64url');
}

function sanitizeToken(v) {
    const s = String(v || '').trim();
    return TOKEN_RE.test(s) ? s : null;
}

/**
 * Uloží nebo aktualizuje košík. Vrací {id, token}. Když token patří už
 * uzavřenému košíku (zaplaceno, odhlášeno, vypršelo), vznikne nový řádek.
 * @param {object} d {token, email, items:[{id,name,qty,unit_price_czk}], shipping_method,
 *   packeta_point, note, goods_czk, shipping_czk, total_czk, ga_client_id, ga_session_id,
 *   fbp, fbc, ip, user_agent, checkout_started}
 */
async function upsertCart(client, d) {
    const vals = [
        d.email, JSON.stringify(d.items || []), d.shipping_method || null,
        d.packeta_point ? JSON.stringify(d.packeta_point) : null, d.note || null,
        d.goods_czk | 0, d.shipping_czk | 0, d.total_czk | 0,
        d.ga_client_id || null, d.ga_session_id || null, d.fbp || null, d.fbc || null,
        d.ip || null, String(d.user_agent || '').slice(0, 300), Boolean(d.checkout_started)
    ];
    const token = sanitizeToken(d.token);
    if (token) {
        const { rows } = await client.query(
            `update shop_carts set
                email = $2, items = $3::jsonb, shipping_method = $4, packeta_point = $5::jsonb, note = $6,
                goods_czk = $7, shipping_czk = $8, total_czk = $9,
                ga_client_id = coalesce($10, ga_client_id), ga_session_id = coalesce($11, ga_session_id),
                fbp = coalesce($12, fbp), fbc = coalesce($13, fbc),
                ip = $14, user_agent = $15, updated_at = now(),
                checkout_started_at = case when $16 then now() else checkout_started_at end
             where token = $1 and status in ('open', 'unsubscribed')
             returning id, token`,
            [token, ...vals]);
        if (rows.length) return rows[0];
    }
    const fresh = newToken();
    const { rows } = await client.query(
        `insert into shop_carts (token, email, items, shipping_method, packeta_point, note,
            goods_czk, shipping_czk, total_czk, ga_client_id, ga_session_id, fbp, fbc, ip, user_agent,
            checkout_started_at, status)
         values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            case when $16 then now() else null end,
            case when exists (select 1 from shop_carts where lower(email) = lower($2) and status = 'unsubscribed')
                 then 'unsubscribed' else 'open' end)
         returning id, token`,
        [fresh, ...vals]);
    return rows[0];
}

// Po zaplacení: uzavře košík z metadat i všechny otevřené košíky se stejným e-mailem
async function markCartsPaid(client, { cartId, email, orderId }) {
    const id = /^[0-9a-f-]{36}$/i.test(String(cartId || '')) ? cartId : null;
    if (!id && !email) return 0;
    const { rowCount } = await client.query(
        `update shop_carts set status = 'paid', paid_at = now(), paid_order_id = coalesce($3, paid_order_id)
         where status in ('open', 'unsubscribed')
           and (($1::uuid is not null and id = $1::uuid) or ($2::text is not null and lower(email) = lower($2)))`,
        [id, email || null, orderId || null]);
    return rowCount;
}

// Odkaz „Zrušit připomínky“ z mailu
async function stopCart(client, rawToken) {
    const token = sanitizeToken(rawToken);
    if (!token) return { ok: false, error: 'bad_token' };
    const { rowCount } = await client.query(
        `update shop_carts set status = 'unsubscribed'
         where status = 'open'
           and (token = $1 or lower(email) in (select lower(email) from shop_carts where token = $1))`,
        [token]);
    return { ok: true, stopped: rowCount };
}

// Připomínky: nikdy nevyhodí výjimku ven kvůli jednomu mailu, chyby loguje.
async function runCartReminders(client, { send = true } = {}) {
    const out = { sent1: 0, sent2: 0, closed: 0, expired: 0, failed: 0 };
    // Úklid: staré košíky už nepřipomínáme
    out.expired = (await client.query(
        `update shop_carts set status = 'expired' where status = 'open' and updated_at < now() - interval '${EXPIRE_AFTER}'`)).rowCount;

    const due1 = (await client.query(
        `select * from shop_carts
         where status = 'open' and email is not null and reminder1_sent_at is null
           and updated_at < now() - interval '${REMINDER_1_AFTER}'
         order by updated_at limit $1`, [MAX_PER_RUN])).rows;
    const due2 = (await client.query(
        `select * from shop_carts
         where status = 'open' and email is not null and reminder2_sent_at is null
           and reminder1_sent_at is not null and reminder1_sent_at < now() - interval '${REMINDER_2_AFTER}'
           and updated_at < now() - interval '${REMINDER_1_AFTER}'
         order by reminder1_sent_at limit $1`, [MAX_PER_RUN])).rows;

    for (const [step, carts] of [[1, due1], [2, due2]]) {
        for (const cart of carts) {
            // Pojistka: koupil mezitím pod stejným e-mailem (třeba jinou cestou)? Pak už nic.
            const { rows } = await client.query(
                `select id from shop_orders where lower(email) = lower($1) and created_at > $2
                   and status not in ('cancelled', 'refunded') limit 1`,
                [cart.email, cart.created_at]);
            if (rows.length) {
                await client.query(
                    `update shop_carts set status = 'paid', paid_at = now(), paid_order_id = $2 where id = $1`,
                    [cart.id, rows[0].id]);
                out.closed++;
                continue;
            }
            if (!send) { step === 1 ? out.sent1++ : out.sent2++; continue; }
            try {
                await sendShopCartReminderEmail({ cart, step });
                await client.query(
                    step === 1
                        ? 'update shop_carts set reminder1_sent_at = now() where id = $1'
                        : 'update shop_carts set reminder2_sent_at = now() where id = $1',
                    [cart.id]);
                step === 1 ? out.sent1++ : out.sent2++;
            } catch (e) {
                out.failed++;
                console.error('cart reminder failed', cart.id, step, e.message);
            }
        }
    }
    return out;
}

module.exports = { upsertCart, markCartsPaid, stopCart, runCartReminders, sanitizeToken };
