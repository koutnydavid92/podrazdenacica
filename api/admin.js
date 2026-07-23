// POST /api/admin - přehled a správa eventu (jen pro Davida, ADMIN_PIN).
// Akce:
//   {pin, action: 'overview'}                        - statistiky + seznamy
//   {pin, action: 'toggle_guestlist', id}            - skrýt/ukázat záznam guestlistu
//   {pin, action: 'create_invite', full_name, greeting_name, email} - nová VIP pozvánka
const crypto = require('crypto');
const { withDb, CAPACITY, currentPriceCzk, pinEquals, clientIp, pinRateLimited, recordPinFailure } = require('./_lib');
const { sendTicketEmail } = require('./_email');

function pinOk(pin) {
    return pinEquals(pin, process.env.ADMIN_PIN);
}

// Kód pozvánky: KATKA-X7QF (jméno + náhodný ocásek, bez matoucích znaků)
function makeCode(fullName) {
    const first = String(fullName || 'HOST').trim().split(/\s+/)[0]
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 12) || 'HOST';
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let tail = '';
    for (let i = 0; i < 4; i++) {
        tail += alphabet[crypto.randomInt(alphabet.length)];
    }
    return `${first}-${tail}`;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const body = req.body || {};
    const ip = clientIp(req);
    try {
        const out = await withDb(async (c) => {
            // Rate limit před ověřením PINu - krátký PIN chrání počítadlo pokusů
            if (await pinRateLimited(c, ip)) return { __status: 429, error: 'rate_limited' };
            if (!pinOk(body.pin)) {
                await recordPinFailure(c, ip, 'admin');
                return { __status: 401, error: 'bad_pin' };
            }
            if (body.action === 'toggle_guestlist') {
                const { rows } = await c.query(
                    'update guestlist set visible = not visible where id = $1 returning id, visible',
                    [body.id]
                );
                return rows.length ? { ok: true, visible: rows[0].visible } : { ok: false };
            }

            if (body.action === 'create_invite') {
                const fullName = String(body.full_name || '').trim();
                const greeting = String(body.greeting_name || '').trim();
                const email = String(body.email || '').trim() || null;
                if (!fullName || !greeting) return { ok: false, error: 'missing_fields' };
                for (let attempt = 0; attempt < 5; attempt++) {
                    const code = makeCode(fullName);
                    try {
                        const { rows } = await c.query(
                            `insert into vip_invites (code, greeting_name, full_name, email)
                             values ($1, $2, $3, $4) returning code`,
                            [code, greeting, fullName, email]
                        );
                        return { ok: true, code: rows[0].code };
                    } catch (e) {
                        if (!String(e.message).includes('duplicate')) throw e;
                    }
                }
                return { ok: false, error: 'code_collision' };
            }

            if (body.action === 'update_invite') {
                const invCode = String(body.code || '').trim();
                const fullName = String(body.full_name || '').trim();
                const greeting = String(body.greeting_name || '').trim();
                if (!invCode) return { ok: false, error: 'missing_code' };
                if (!fullName || !greeting) return { ok: false, error: 'missing_fields' };

                const { rows } = await c.query(
                    'select id from vip_invites where upper(code) = upper($1)',
                    [invCode]
                );
                if (!rows.length) return { ok: false, error: 'not_found' };

                await c.query(
                    'update vip_invites set full_name = $2, greeting_name = $3 where id = $1',
                    [rows[0].id, fullName, greeting]
                );
                // jméno se propíše i na případnou vstupenku (guestlist nechávám,
                // ten si host vyplňuje sám)
                await c.query(
                    "update tickets set name = $2 where invite_id = $1 and status <> 'cancelled'",
                    [rows[0].id, fullName]
                );
                return { ok: true };
            }

            if (body.action === 'set_invite_email') {
                const invCode = String(body.code || '').trim();
                const email = String(body.email || '').trim();
                if (!invCode) return { ok: false, error: 'missing_code' };
                if (!email || email.indexOf('@') === -1) return { ok: false, error: 'invalid_email' };

                const { rows: invRows } = await c.query(
                    'select id, status, full_name, greeting_name, email from vip_invites where upper(code) = upper($1)',
                    [invCode]
                );
                if (!invRows.length) return { ok: false, error: 'not_found' };
                const inv = invRows[0];
                const changed = (inv.email || '') !== email;

                await c.query('update vip_invites set email = $2 where id = $1', [inv.id, email]);
                await c.query(
                    "update tickets set email = $2 where invite_id = $1 and status <> 'cancelled'",
                    [inv.id, email]
                );

                // Potvrzená pozvánka: pošli QR vstupenku hned. Znovu jen když
                // admin e-mail opravil (jinak by opakovaný klik posílal duplicitně).
                let sent = false;
                if (inv.status === 'confirmed') {
                    const { rows: tRows } = await c.query(
                        `select id, qr_token, ticket_no, email_sent_at from tickets
                         where invite_id = $1 and status <> 'cancelled'`,
                        [inv.id]
                    );
                    const toSend = tRows.filter(t => !t.email_sent_at || changed);
                    if (toSend.length) {
                        await sendTicketEmail({
                            to: email,
                            name: inv.full_name,
                            greetingName: inv.greeting_name,
                            tickets: toSend,
                            isVip: true
                        });
                        await c.query(
                            'update tickets set email_sent_at = now() where id = any($1)',
                            [toSend.map(r => r.id)]
                        );
                        sent = true;
                    }
                }
                return { ok: true, sent, status: inv.status };
            }

            // overview (výchozí)
            const one = async (sql) => (await c.query(sql)).rows[0];
            const stats = {
                capacity: CAPACITY,
                price: currentPriceCzk(),
                sold: (await one("select count(*)::int as n from tickets where type='public' and status <> 'cancelled'")).n,
                occupied: (await one("select count(*)::int as n from tickets where status <> 'cancelled'")).n,
                vip_confirmed: (await one("select count(*)::int as n from vip_invites where status='confirmed'")).n,
                vip_declined: (await one("select count(*)::int as n from vip_invites where status='declined'")).n,
                vip_pending: (await one("select count(*)::int as n from vip_invites where status='invited'")).n,
                checked_in: (await one("select count(*)::int as n from tickets where status='checked_in'")).n,
                guestlist_visible: (await one('select count(*)::int as n from guestlist where visible')).n,
                newsletter_optins: (await one('select count(*)::int as n from guestlist where newsletter')).n
            };
            // tržba ze skutečně zaplacených cen (early bird vs plná)
            stats.revenue = (await one(
                "select coalesce(sum(price_czk), 0)::int as n from tickets where type='public' and status <> 'cancelled'"
            )).n;

            const invites = (await c.query(
                `select code, greeting_name, full_name, email, status, responded_at
                 from vip_invites order by created_at desc`
            )).rows;
            const guestlist = (await c.query(
                `select id, name, role, bio, visible, newsletter, created_at
                 from guestlist order by created_at desc`
            )).rows;
            const tickets = (await c.query(
                `select name, email, type, status, ticket_no, stripe_session_id, checked_in_at, created_at
                 from tickets order by created_at desc limit 500`
            )).rows;

            return { ok: true, stats, invites, guestlist, tickets };
        });
        const status = out.__status || 200;
        delete out.__status;
        res.status(status).json(out);
    } catch (e) {
        console.error('admin error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
