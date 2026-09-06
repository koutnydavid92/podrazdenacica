// POST /api/newsletter {kind: 'vip'|'public', ref: <kód pozvánky | session_id>}
// Zapíše kontakt do Ecomail listu. Nevěří klientovi: souhlas (newsletter=true)
// i e-mail se čtou z databáze podle předaného odkazu.
//
// POST /api/newsletter {kind: 'onanovanky_ukazka', email, website}
// Ukázka Onanovánek: pošle 5 stránek na mail a kontakt uloží se štítkem.
// Žije tady kvůli limitu 12 funkcí na Vercelu.
const { withDb, clientIp } = require('./_lib');
const {
    subscribeToNewsletter, sendShopSampleEmail, subscribeToShopListSafe, SHOP_TAG_SAMPLE
} = require('./_email');

async function sampleRequest(req, res) {
    const b = req.body || {};
    // honeypot: skryté pole, které vyplní jen roboti
    if (b.website) {
        res.status(200).json({ ok: true });
        return;
    }
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.status(400).json({ error: 'bad_email' });
        return;
    }
    const ip = clientIp(req);
    const allowed = await withDb(async (c) => {
        // jemný limit: 5 žádostí z IP za den, 2 na stejný mail za den
        const { rows } = await c.query(
            `select
                (select count(*)::int from shop_samples where ip = $1 and created_at > now() - interval '1 day') as from_ip,
                (select count(*)::int from shop_samples where email = $2 and created_at > now() - interval '1 day') as same_mail`,
            [ip, email]);
        if (rows[0].from_ip >= 5 || rows[0].same_mail >= 2) return false;
        await c.query(
            'insert into shop_samples (email, ip, sent_at) values ($1, $2, now())', [email, ip]);
        return true;
    });
    if (!allowed) {
        res.status(429).json({ error: 'too_many' });
        return;
    }
    await sendShopSampleEmail({ to: email });
    await subscribeToShopListSafe({ email, name: '', tag: SHOP_TAG_SAMPLE });
    res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const kind = (req.body && req.body.kind) || '';
    if (kind === 'onanovanky_ukazka') {
        try {
            await sampleRequest(req, res);
        } catch (e) {
            console.error('sample error:', e.message);
            res.status(500).json({ error: 'server_error' });
        }
        return;
    }
    const ref = ((req.body && req.body.ref) || '').trim();
    if (!ref || !['vip', 'public'].includes(kind)) {
        res.status(400).json({ error: 'bad_request' });
        return;
    }
    try {
        const contact = await withDb(async (c) => {
            const query = kind === 'vip'
                ? `select g.name, i.email from guestlist g
                   join vip_invites i on i.id = g.invite_id
                   where upper(i.code) = upper($1) and g.newsletter`
                : `select g.name, t.email from guestlist g
                   join tickets t on t.id = g.ticket_id
                   where t.stripe_session_id = $1 and g.newsletter`;
            const { rows } = await c.query(query, [ref]);
            return rows[0] || null;
        });
        if (contact && contact.email) {
            await subscribeToNewsletter({ email: contact.email, name: contact.name });
            res.status(200).json({ ok: true, subscribed: true });
        } else {
            res.status(200).json({ ok: true, subscribed: false });
        }
    } catch (e) {
        console.error('newsletter error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
