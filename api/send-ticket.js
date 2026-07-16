// POST /api/send-ticket {code} - pošle VIP vstupenku e-mailem po potvrzení RSVP.
// Volá ho VIP stránka po kliknutí na "Jasně že přijdu". Vše se ověřuje
// v databázi: kód musí existovat, být potvrzený a mít e-mail.
// Odesílá se jen jednou (email_sent_at), opakované kliknutí nespamuje.
const { withDb } = require('./_lib');
const { sendTicketEmail } = require('./_email');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const code = ((req.body && req.body.code) || '').trim();
    if (!code) {
        res.status(400).json({ error: 'missing_code' });
        return;
    }
    try {
        const result = await withDb(async (c) => {
            const { rows } = await c.query(
                `select t.id, t.qr_token, t.ticket_no, i.full_name, i.greeting_name, i.email
                 from vip_invites i
                 join tickets t on t.invite_id = i.id and t.status <> 'cancelled'
                 where upper(i.code) = upper($1) and i.status = 'confirmed'
                   and t.email_sent_at is null`,
                [code]
            );
            if (!rows.length || !rows[0].email) return { sent: false };
            await sendTicketEmail({
                to: rows[0].email,
                name: rows[0].full_name,
                greetingName: rows[0].greeting_name,
                tickets: rows,
                isVip: true
            });
            await c.query(
                'update tickets set email_sent_at = now() where id = any($1)',
                [rows.map(r => r.id)]
            );
            return { sent: true };
        });
        res.status(200).json({ ok: true, ...result });
    } catch (e) {
        console.error('send-ticket error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
