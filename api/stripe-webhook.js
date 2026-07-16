// POST /api/stripe-webhook - Stripe sem posílá události o platbách.
// Po zaplacené checkout session vytvoří vstupenky v Supabase.
// Podpis se ověřuje proti STRIPE_WEBHOOK_SECRET, proto surové tělo requestu.
const Stripe = require('stripe');
const { withDb, fulfillSession } = require('./_lib');
const { sendTicketEmail } = require('./_email');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    let event;
    try {
        const raw = await readRawBody(req);
        event = stripe.webhooks.constructEvent(
            raw,
            req.headers['stripe-signature'],
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (e) {
        console.error('webhook signature error:', e.message);
        res.status(400).json({ error: 'invalid_signature' });
        return;
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            if (session.payment_status === 'paid'
                && session.metadata && session.metadata.event === 'cica-art-fest') {
                const items = await stripe.checkout.sessions.listLineItems(session.id);
                const quantity = items.data.reduce((s, i) => s + (i.quantity || 0), 0) || 1;
                const result = await withDb(c => fulfillSession(c, session, quantity));
                console.log('fulfilled', session.id, JSON.stringify(result));

                // E-mail se vstupenkami: jen pro dosud neodeslané (retry-safe)
                await withDb(async (c) => {
                    const { rows } = await c.query(
                        `select qr_token, ticket_no, name, email from tickets
                         where stripe_session_id = $1 and email_sent_at is null
                         order by ticket_no`,
                        [session.id]
                    );
                    if (!rows.length || !rows[0].email) return;
                    await sendTicketEmail({
                        to: rows[0].email,
                        name: rows[0].name,
                        tickets: rows,
                        isVip: false
                    });
                    await c.query(
                        'update tickets set email_sent_at = now() where stripe_session_id = $1',
                        [session.id]
                    );
                    console.log('ticket email sent', session.id, rows.length);
                });
            }
        }
        res.status(200).json({ received: true });
    } catch (e) {
        // 500 -> Stripe událost pošle znovu (fulfillSession je idempotentní)
        console.error('webhook processing error:', e.message);
        res.status(500).json({ error: 'processing_error' });
    }
};
