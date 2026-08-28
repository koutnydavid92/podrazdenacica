// POST /api/checkin - odbavení u vchodu (skenovačka).
// PIN se ověřuje proti CHECKIN_PIN nebo ADMIN_PIN (env proměnné).
// Akce:
//   {pin, token}      - sken QR: označí vstupenku jako odbavenou
//   {pin, ticket_id}  - ruční odbavení (z vyhledávání)
//   {pin, search}     - hledání podle jména/e-mailu (mrtvý QR apod.);
//                       najde i mlčící VIP, kteří ještě nemají vstupenku
//   {pin, admit_code} - VIP bez vstupenky u vchodu: vytvoří VIP vstupenku
//                       a rovnou ji odbaví (potvrdí i pozvánku)
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

// VIP host, který dorazil bez vstupenky (pozvánku nepotvrdil). U vchodu mu
// vytvoříme VIP vstupenku rovnou jako odbavenou a potvrdíme pozvánku.
// Idempotentní: opakovaný klik nezaloží druhou vstupenku (zámek na pozvánce).
async function admitInvite(client, code) {
    await client.query('begin');
    try {
        const { rows: invRows } = await client.query(
            "select id, full_name, email, status from vip_invites where upper(code) = upper($1) for update",
            [code]
        );
        if (!invRows.length) { await client.query('rollback'); return { result: 'not_found' }; }
        const inv = invRows[0];

        // Už nějaká nezrušená vstupenka existuje? (host mezitím potvrdil, nebo dvojklik)
        const { rows: tRows } = await client.query(
            "select id, status, checked_in_at from tickets where invite_id = $1 and status <> 'cancelled' order by created_at limit 1",
            [inv.id]
        );
        if (tRows.length) {
            const t = tRows[0];
            if (t.status === 'checked_in') {
                await client.query('commit');
                return { result: 'already', name: inv.full_name, type: 'vip', checked_in_at: t.checked_in_at };
            }
            await client.query("update tickets set status = 'checked_in', checked_in_at = now() where id = $1", [t.id]);
            if (inv.status !== 'confirmed') {
                await client.query("update vip_invites set status = 'confirmed', responded_at = coalesce(responded_at, now()) where id = $1", [inv.id]);
            }
            await client.query('commit');
            return { result: 'ok', name: inv.full_name, type: 'vip' };
        }

        // Žádná vstupenka: potvrdit pozvánku a vytvořit rovnou odbavenou vstupenku
        await client.query("update vip_invites set status = 'confirmed', responded_at = coalesce(responded_at, now()) where id = $1", [inv.id]);
        await client.query(
            "insert into tickets (type, invite_id, name, email, status, checked_in_at) values ('vip', $1, $2, $3, 'checked_in', now())",
            [inv.id, inv.full_name, inv.email]
        );
        await client.query('commit');
        return { result: 'ok', name: inv.full_name, type: 'vip' };
    } catch (e) {
        await client.query('rollback');
        throw e;
    }
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
            if (body.admit_code) {
                const code = String(body.admit_code).trim();
                if (!code) return { result: 'not_found' };
                return admitInvite(c, code);
            }
            if (body.search) {
                const q = '%' + String(body.search).trim() + '%';
                const { rows: tickets } = await c.query(
                    `select id, name, email, type, status, ticket_no from tickets
                     where (name ilike $1 or email ilike $1) and status <> 'cancelled'
                     order by name limit 12`,
                    [q]
                );
                // Mlčící VIP (pozvánka bez vstupenky) - ať je u vchodu dohledáš
                const { rows: invites } = await c.query(
                    `select code, full_name as name, email from vip_invites i
                     where status = 'invited'
                       and (full_name ilike $1 or email ilike $1)
                       and not exists (select 1 from tickets t
                                       where t.invite_id = i.id and t.status <> 'cancelled')
                     order by full_name limit 12`,
                    [q]
                );
                const matches = tickets.map(t => Object.assign({ source: 'ticket' }, t))
                    .concat(invites.map(i => ({ source: 'invite', code: i.code, name: i.name, email: i.email })));
                return { result: 'search', matches };
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
