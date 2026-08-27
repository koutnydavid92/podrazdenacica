// POST /api/drazba-admin - správa dražby (jen pro Davida, ADMIN_PIN).
// Akce:
//   {pin, action:'overview'}                       - stav, díla, top příhozy, počty
//   {pin, action:'set_mode', mode}                 - 'test' | 'live' | 'closed'
//   {pin, action:'wipe_test'}                      - smazat testovací příhozy
//   {pin, action:'live_bid', slug, amount, name}   - živý příhoz z pléna
//   {pin, action:'delete_bid', bid_id}             - smazat překlep (ukliknutý příhoz)
//   {pin, action:'all_bids', slug?}                - kompletní historie příhozů (volitelně jen jedno dílo)
//   {pin, action:'winners'}                        - vítězové s kontakty
//   {pin, action:'send_winner_emails'}             - poslat vítězům e-mail s platbou
const { withDb, pinEquals, clientIp, pinRateLimited, recordPinFailure } = require('./_lib');
const { sendWinnerEmail } = require('./_email');

const MIN_INCREMENT = 100;
const BASE_URL = 'https://www.podrazdenacica.cz';

async function currentMode(c) {
    const { rows } = await c.query('select mode from auction_settings where id = 1');
    return rows[0].mode;
}

// Vítězové: nejvyšší příhoz každého díla (jen ostrá data)
async function winners(c) {
    const { rows } = await c.query(
        `select distinct on (i.id)
                i.slug, i.title, i.starting_price_czk, i.sort,
                b.id as bid_id, b.amount_czk, b.source, b.created_at,
                coalesce(bd.name, b.live_name) as winner_name,
                bd.email as winner_email
         from auction_items i
         left join bids b on b.item_id = i.id and b.is_test = false
         left join bidders bd on bd.id = b.bidder_id
         where i.withdrawn = false
         order by i.id, b.amount_czk desc nulls last, b.created_at asc`
    );
    return rows.sort((a, b) => a.sort - b.sort).map(r => ({
        slug: r.slug, title: r.title, starting: r.starting_price_czk,
        bid_id: r.bid_id, amount: r.amount_czk, source: r.source,
        winner_name: r.winner_name, winner_email: r.winner_email
    }));
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
            if (await pinRateLimited(c, ip)) return { __status: 429, error: 'rate_limited' };
            if (!pinEquals(body.pin, process.env.ADMIN_PIN)) {
                await recordPinFailure(c, ip, 'drazba-admin');
                return { __status: 401, error: 'bad_pin' };
            }

            if (body.action === 'overview') {
                const { rows: settings } = await c.query(
                    'select mode, opens_at, closes_at from auction_settings where id = 1');
                const test = settings[0].mode === 'test';
                const { rows: items } = await c.query(
                    `select i.slug, i.title, i.starting_price_czk, i.charity,
                            max(b.amount_czk)::int as top_amount,
                            count(b.id)::int as bid_count
                     from auction_items i
                     left join bids b on b.item_id = i.id and b.is_test = $1
                     group by i.id order by i.sort`, [test]);
                const { rows: latest } = await c.query(
                    `select b.id, i.title, b.amount_czk, b.source, b.is_test, b.created_at,
                            coalesce(bd.name, b.live_name) as name, bd.email
                     from bids b
                     join auction_items i on i.id = b.item_id
                     left join bidders bd on bd.id = b.bidder_id
                     where b.is_test = $1
                     order by b.created_at desc limit 30`, [test]);
                const { rows: counts } = await c.query(
                    `select count(*)::int as bidders,
                            count(*) filter (where verified_at is not null)::int as verified
                     from bidders`);
                return { ok: true, settings: settings[0], items, latest, bidders: counts[0] };
            }

            if (body.action === 'set_mode') {
                const mode = String(body.mode || '');
                if (!['test', 'live', 'closed'].includes(mode)) return { ok: false, error: 'bad_mode' };
                await c.query('update auction_settings set mode = $1, updated_at = now() where id = 1', [mode]);
                return { ok: true, mode };
            }

            if (body.action === 'wipe_test') {
                const { rowCount } = await c.query('delete from bids where is_test = true');
                return { ok: true, deleted: rowCount };
            }

            if (body.action === 'live_bid') {
                const slug = String(body.slug || '').trim();
                const amount = Math.round(Number(body.amount));
                const name = String(body.name || '').trim().slice(0, 120) || 'plénum';
                if (!slug || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'missing_fields' };
                const test = (await currentMode(c)) === 'test';
                const { rows: irows } = await c.query(
                    'select id, starting_price_czk from auction_items where slug = $1', [slug]);
                if (!irows.length) return { ok: false, error: 'unknown_item' };
                const { rows: top } = await c.query(
                    `select amount_czk from bids where item_id = $1 and is_test = $2
                     order by amount_czk desc limit 1`, [irows[0].id, test]);
                const minimum = top.length ? top[0].amount_czk + MIN_INCREMENT : irows[0].starting_price_czk;
                if (amount < minimum) return { ok: false, error: 'too_low', minimum };
                await c.query(
                    `insert into bids (item_id, live_name, amount_czk, source, is_test)
                     values ($1, $2, $3, 'live', $4)`,
                    [irows[0].id, name, amount, test]
                );
                return { ok: true, top: amount };
            }

            if (body.action === 'all_bids') {
                const slug = String(body.slug || '').trim() || null;
                const test = (await currentMode(c)) === 'test';
                const { rows } = await c.query(
                    `select b.id, i.title, b.amount_czk, b.source, b.created_at,
                            coalesce(bd.name, b.live_name) as name, bd.email
                     from bids b
                     join auction_items i on i.id = b.item_id
                     left join bidders bd on bd.id = b.bidder_id
                     where b.is_test = $1 and ($2::text is null or i.slug = $2)
                     order by b.created_at desc`,
                    [test, slug]
                );
                return { ok: true, bids: rows };
            }

            if (body.action === 'delete_bid') {
                const bidId = Math.round(Number(body.bid_id));
                if (!Number.isFinite(bidId) || bidId <= 0) return { ok: false, error: 'missing_fields' };
                const { rows } = await c.query(
                    `delete from bids where id = $1
                     returning amount_czk, (select title from auction_items where id = item_id) as title`,
                    [bidId]
                );
                if (!rows.length) return { ok: false, error: 'not_found' };
                return { ok: true, deleted: { title: rows[0].title, amount: rows[0].amount_czk } };
            }

            if (body.action === 'winners') {
                return { ok: true, winners: await winners(c) };
            }

            if (body.action === 'send_winner_emails') {
                const list = (await winners(c)).filter(w => w.amount && w.winner_email);
                const sent = [];
                const failed = [];
                for (const w of list) {
                    try {
                        await sendWinnerEmail({
                            to: w.winner_email, name: w.winner_name,
                            itemTitle: w.title, amount: w.amount,
                            qrUrl: `${BASE_URL}/api/qr?bid=${w.bid_id}`
                        });
                        sent.push(w.slug);
                    } catch (e) {
                        console.error('winner email failed for', w.winner_email, '->', e.message);
                        failed.push(w.slug);
                    }
                }
                return { ok: true, sent, failed };
            }

            return { ok: false, error: 'unknown_action' };
        });
        res.status(out.__status || 200).json(out);
    } catch (e) {
        console.error('drazba-admin error from', ip, '->', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
