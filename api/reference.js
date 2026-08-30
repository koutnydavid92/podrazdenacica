// GET /api/reference - veřejné reference z dotazníku (jen věty se souhlasem).
// Nic osobního: jde ven jen text a podpis, který si člověk sám zvolil.
const { withDb } = require('./_lib');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    try {
        const quotes = await withDb(async (c) => {
            const { rows } = await c.query(
                `select quote, quote_author as author from caf_feedback
                 where quote_public and quote is not null
                 order by created_at desc limit 60`);
            return rows;
        });
        // 5 minut na CDN, ať se nové věty objeví samy a DB se nedře
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
        res.status(200).json({ quotes });
    } catch (e) {
        console.error('reference error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
