// POST /api/newsletter {kind: 'vip'|'public', ref: <kód pozvánky | session_id>}
// Zapíše kontakt do Ecomail listu. Nevěří klientovi: souhlas (newsletter=true)
// i e-mail se čtou z databáze podle předaného odkazu.
const { withDb } = require('./_lib');
const { subscribeToNewsletter } = require('./_email');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const kind = (req.body && req.body.kind) || '';
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
