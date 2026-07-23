// POST /api/checkin - odbavení u vchodu (skenovačka).
// PIN se ověřuje proti CHECKIN_PIN nebo ADMIN_PIN (env proměnné).
// Akce:
//   {pin, token}     - sken QR: označí vstupenku jako odbavenou
//   {pin, ticket_id} - ruční odbavení (z vyhledávání)
//   {pin, search}    - hledání podle jména/e-mailu (mrtvý QR apod.)
const { withDb, pinEquals, clientIp, pinRateLimited, recordPinFailure } = require('./_lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pinOk(pin) {
    return [process.env.CHECKIN_PIN, process.env.ADMIN_PIN]
        .filter(Boolean).some(p => pinEquals(pin, p));
}

async function checkInBy(client, whereSql, value) {
    const { rows } = await client.query(
        `select id, name, type, status, checked_in_at, ticket_no from tickets where ${whereSql}`,
        [value]
    );
    if (!rows.length) return { result: 'not_found' };
    const t = rows[0];
    if (t.status === 'cancelled') return { result: 'cancelled', name: t.name, type: t.type };
    if (t.status === 'checked_in') {
        return { result: 'already', name: t.name, type: t.type, checked_in_at: t.checked_in_at };
    }
    await client.query(
        "update tickets set status = 'checked_in', checked_in_at = now() where id = $1",
        [t.id]
    );
    return { result: 'ok', name: t.name, type: t.type, ticket_no: t.ticket_no };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method_not_allowed' });
        return;
    }
    const body = req.body || {};
    const ip = clientIp(req);
    try {
        const out = await withDb(async (c) => {
            // Rate limit před ověřením PINu - krátký PIN chrání počítadlo pokusů
            if (await pinRateLimited(c, ip)) return { __status: 429, error: 'rate_limited' };
            if (!pinOk(body.pin)) {
                await recordPinFailure(c, ip, 'checkin');
                return { __status: 401, error: 'bad_pin' };
            }
            if (body.token) {
                if (!UUID_RE.test(String(body.token).trim())) return { result: 'not_found' };
                return checkInBy(c, 'qr_token = $1', String(body.token).trim());
            }
            if (body.ticket_id) {
                if (!UUID_RE.test(String(body.ticket_id).trim())) return { result: 'not_found' };
                return checkInBy(c, 'id = $1', String(body.ticket_id).trim());
            }
            if (body.search) {
                const q = '%' + String(body.search).trim() + '%';
                const { rows } = await c.query(
                    `select id, name, email, type, status, ticket_no from tickets
                     where (name ilike $1 or email ilike $1) and status <> 'cancelled'
                     order by name limit 12`,
                    [q]
                );
                return { result: 'search', matches: rows };
            }
            return { result: 'bad_request' };
        });
        const status = out.__status || 200;
        delete out.__status;
        res.status(status).json(out);
    } catch (e) {
        console.error('checkin error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
