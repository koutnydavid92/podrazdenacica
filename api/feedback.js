// POST /api/feedback - anonymní zpětná vazba po Číča Art Festu.
// Jméno se ukládá jen když člověk souhlasí se zveřejněním své věty.
const { withDb, clientIp } = require('./_lib');

const ALLOWED_HIGHLIGHTS = [
    'welcome', 'tattoo', 'market', 'tvurcici', 'vernisaz', 'vazky', 'panelovka',
    'standup', 'krupicafaja', 'prehlidka', 'drazba', 'onanovanky', 'misspetty',
    'lokalita'
];

module.exports = async (req, res) => {
    // GET vrací veřejné reference (věty se souhlasem) pro web festu
    if (req.method === 'GET') {
        try {
            const quotes = await withDb(async (c) => {
                const { rows } = await c.query(
                    `select quote, quote_author as author from caf_feedback
                     where quote_public and quote is not null
                     order by created_at desc limit 60`);
                return rows;
            });
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
            res.status(200).json({ quotes });
        } catch (e) {
            console.error('reference error:', e.message);
            res.status(500).json({ error: 'server_error' });
        }
        return;
    }
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
    const comeAgain = ['ano', 'mozna', 'ne'].includes(b.come_again) ? b.come_again : null;
    const ALLOWED_BRING = ['kamosky', 'partner', 'mamu', 'rodinu', 'kolegy', 'deti', 'sam'];
    const bringWho = Array.isArray(b.bring_who)
        ? b.bring_who.filter(x => ALLOWED_BRING.includes(x)).slice(0, ALLOWED_BRING.length)
        : [];
    const improve = clip(b.improve, 2000);
    const artistTip = clip(b.artist_tip, 500);
    const quote = clip(b.quote, 500);
    const quotePublic = Boolean(b.quote_public) && Boolean(quote);
    const quoteAuthor = quotePublic ? (clip(b.quote_author, 100) || 'Anonymní číča') : null;
    // Nepovinný e-mail: kdo ho nechá, dostane 5 stránek z Onanovánek.
    // Bereme jen rozumný tvar, jinak necháme prázdný (dotazník nepadá kvůli mailu).
    const emailRaw = clip(b.email, 200);
    const email = emailRaw && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw)
        ? emailRaw.toLowerCase() : null;

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
                `insert into caf_feedback (rating, highlights, improve, quote, quote_public, quote_author, artist_tip, email, come_again, bring_who, ip)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [rating, highlights, improve, quote, quotePublic, quoteAuthor, artistTip, email, comeAgain, bringWho, ip]);
            res.status(200).json({ ok: true });
        });
    } catch (e) {
        console.error('feedback error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
