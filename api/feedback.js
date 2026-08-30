// POST /api/feedback - anonymní zpětná vazba po Číča Art Festu.
// Jméno se ukládá jen když člověk souhlasí se zveřejněním své věty.
const { withDb, clientIp } = require('./_lib');

const ALLOWED_HIGHLIGHTS = [
    'welcome', 'tattoo', 'market', 'vernisaz', 'vazky', 'panelovka',
    'standup', 'krupicafaja', 'prehlidka', 'drazba', 'onanovanky', 'misspetty'
];

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const b = req.body || {};
    // honeypot: skryté pole, které vyplní jen roboti
    if (b.website) {
        res.status(200).json({ ok: true });
        return;
    }
    const rating = parseInt(b.rating, 10);
    if (!(rating >= 1 && rating <= 5)) {
        res.status(400).json({ error: 'bad_rating' });
        return;
    }
    const highlights = Array.isArray(b.highlights)
        ? b.highlights.filter(h => ALLOWED_HIGHLIGHTS.includes(h)).slice(0, ALLOWED_HIGHLIGHTS.length)
        : [];
    const clip = (v, max) => String(v || '').trim().slice(0, max) || null;
    const improve = clip(b.improve, 2000);
    const quote = clip(b.quote, 500);
    const quotePublic = Boolean(b.quote_public) && Boolean(quote);
    const quoteAuthor = quotePublic ? clip(b.quote_author, 100) : null;

    try {
        await withDb(async (c) => {
            // jemný limit: max 5 odpovědí z jedné IP za den, ať nejde spamovat
            const ip = clientIp(req);
            const { rows } = await c.query(
                `select count(*)::int as n from caf_feedback
                 where ip = $1 and created_at > now() - interval '1 day'`, [ip]);
            if (rows[0].n >= 5) {
                res.status(429).json({ error: 'too_many' });
                return;
            }
            await c.query(
                `insert into caf_feedback (rating, highlights, improve, quote, quote_public, quote_author, ip)
                 values ($1, $2, $3, $4, $5, $6, $7)`,
                [rating, highlights, improve, quote, quotePublic, quoteAuthor, ip]);
            res.status(200).json({ ok: true });
        });
    } catch (e) {
        console.error('feedback error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
