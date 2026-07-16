// GET /api/qr?token=<uuid> - PNG s QR kódem vstupenky.
// Token se ověřuje proti databázi, aby se přes nás nedaly generovat
// libovolné QR kódy.
const QRCode = require('qrcode');
const { withDb } = require('./_lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
    const token = ((req.query && req.query.token) || '').trim();
    if (!UUID_RE.test(token)) {
        res.status(400).json({ error: 'bad_token' });
        return;
    }
    try {
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
