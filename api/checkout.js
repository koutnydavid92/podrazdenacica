// POST /api/checkout - založí Stripe Checkout Session pro nákup vstupenek.
// Hlídá kapacitu (200 veřejných vstupenek) ještě před přesměrováním na platbu.
const Stripe = require('stripe');
const { withDb, remainingPublic, currentPriceCzk } = require('./_lib');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        const remaining = await withDb(remainingPublic);
        if (remaining <= 0) {
            res.status(409).json({ error: 'sold_out' });
            return;
        }

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
            metadata: { event: 'cica-art-fest' },
            success_url: origin + '/cica-art-fest/dekuji?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: origin + '/cica-art-fest#vstupenky'
        });

        res.status(200).json({ url: session.url });
    } catch (e) {
        console.error('checkout error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
