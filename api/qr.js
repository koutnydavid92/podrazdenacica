// GET /api/qr?token=<uuid> - PNG s QR kódem vstupenky.
// GET /api/qr?bid=<id>     - PNG s QR platbou za vyhranou dražbu (SPD formát).
// Vstup se vždy ověřuje proti databázi, aby se přes nás nedaly
// generovat libovolné QR kódy.
const QRCode = require('qrcode');
const { withDb } = require('./_lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_IBAN = 'CZ2830300000001952337019'; // 1952337019/3030

// SPD string pro QR platbu za vyhrané dílo (jen skutečný vítězný příhoz)
async function bidPayload(bidId) {
    return withDb(async (c) => {
        const { rows } = await c.query(
            `select b.amount_czk, i.title
             from bids b join auction_items i on i.id = b.item_id
             where b.id = $1 and b.is_test = false
               and b.amount_czk = (select max(amount_czk) from bids
                                   where item_id = b.item_id and is_test = false)`,
            [bidId]
        );
        if (!rows.length) return null;
        const msg = ('DRAZBA ' + rows[0].title).normalize('NFD')
            .replace(/[̀-ͯ]/g, '').toUpperCase()
            .replace(/[^A-Z0-9 ]/g, '').slice(0, 60);
        return `SPD*1.0*ACC:${ACCOUNT_IBAN}*AM:${rows[0].amount_czk}.00*CC:CZK*MSG:${msg}`;
    });
}

module.exports = async (req, res) => {
    const token = ((req.query && req.query.token) || '').trim();
    const bid = ((req.query && req.query.bid) || '').trim();
    try {
        if (bid) {
            if (!/^\d{1,12}$/.test(bid)) {
                res.status(400).json({ error: 'bad_bid' });
                return;
            }
            const payload = await bidPayload(Number(bid));
            if (!payload) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            const png = await QRCode.toBuffer(payload, {
                type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M'
            });
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.status(200).send(png);
            return;
        }
        if (!UUID_RE.test(token)) {
            res.status(400).json({ error: 'bad_token' });
            return;
        }
        const exists = await withDb(async (c) => {
            const { rows } = await c.query('select 1 from tickets where qr_token = $1', [token]);
            return rows.length > 0;
        });
        if (!exists) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        const png = await QRCode.toBuffer(token, {
            type: 'png',
            width: 480,
            margin: 2,
            errorCorrectionLevel: 'M'
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.status(200).send(png);
    } catch (e) {
        console.error('qr error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
