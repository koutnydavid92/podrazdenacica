// /api/drazba - veřejné API tiché dražby.
//   GET  ?t=<token>                                  - stav dražby (token nepovinný,
//                                                      s ním se přidá, kde vedu já)
//   POST {action:'register', email, name, newsletter} - poslat ověřovací odkaz
//   POST {action:'verify', token}                     - potvrdit e-mail z odkazu
//   POST {action:'bid', token, slug, amount}          - přihodit
//
// Bezpečnostní model: tabulky jsou zamčené, sem tečou jen přes tento
// backend. Příhoz projde jen ověřenému e-mailu, v povoleném okně
// a aspoň o MIN_INCREMENT nad aktuální maximum (souběh řeší advisory
// lock na dílo). V režimu 'test' se příhozy značí is_test a před
// ostrým startem se mažou.
const { withDb, clientIp } = require('./_lib');
const { sendAuctionVerifyEmail, sendOutbidEmail, subscribeToNewsletter } = require('./_email');

const MIN_INCREMENT = 100;
const MAX_AMOUNT = 1000000; // pojistka proti překlepům typu "25000000"

function cleanEmail(s) {
    const e = String(s || '').trim().toLowerCase();
    return e.includes('@') && e.length <= 200 ? e : null;
}

async function getSettings(c) {
    const { rows } = await c.query('select mode, opens_at, closes_at from auction_settings where id = 1');
    return rows[0];
}

// Testovací režim pracuje s testovacími příhozy, ostrý s ostrými
function isTest(settings) {
    return settings.mode === 'test';
}

async function auctionState(c, settings, bidderId) {
    const { rows } = await c.query(
        `select i.slug, i.title, i.starting_price_czk, i.charity, i.withdrawn,
                max(b.amount_czk)::int as top_amount,
                count(b.id)::int as bid_count,
                (max(b.amount_czk) is not null and
                 (array_agg(b.bidder_id order by b.amount_czk desc, b.created_at asc))[1] = $2) as leading
         from auction_items i
         left join bids b on b.item_id = i.id and b.is_test = $1
         group by i.id
         order by i.sort`,
        [isTest(settings), bidderId]
    );
    return {
        mode: settings.mode,
        opens_at: settings.opens_at,
        closes_at: settings.closes_at,
        now: new Date().toISOString(),
        items: rows.map(r => ({
            slug: r.slug,
            title: r.title,
            starting: r.starting_price_czk,
            charity: r.charity,
            withdrawn: r.withdrawn,
            top: r.top_amount,
            bids: r.bid_count,
            leading: bidderId ? r.leading : false
        }))
    };
}

module.exports = async (req, res) => {
    try {
        if (req.method === 'GET') {
            const token = String(req.query.t || '').trim() || null;
            const out = await withDb(async (c) => {
                const settings = await getSettings(c);
                let bidder = null;
                if (token) {
                    const { rows } = await c.query(
                        'select id, name, verified_at from bidders where token = $1', [token]);
                    if (rows.length && rows[0].verified_at) bidder = rows[0];
                }
                const state = await auctionState(c, settings, bidder ? bidder.id : null);
                if (bidder) state.me = { name: bidder.name };
                return state;
            });
            res.status(200).json(out);
            return;
        }

        if (req.method !== 'POST') {
            res.status(405).json({ error: 'method_not_allowed' });
            return;
        }

        const body = req.body || {};

        if (body.action === 'register') {
            const email = cleanEmail(body.email);
            const name = String(body.name || '').trim().slice(0, 120);
            if (!email || !name) {
                res.status(400).json({ ok: false, error: 'missing_fields' });
                return;
            }
            const out = await withDb(async (c) => {
                // jeden ověřovací mail za minutu na e-mail stačí každému
                const { rows } = await c.query(
                    `insert into bidders (email, name, newsletter)
                     values ($1, $2, $3)
                     on conflict (lower(email)) do update
                         set name = excluded.name,
                             newsletter = bidders.newsletter or excluded.newsletter
                     returning id, token, verified_at, last_email_at`,
                    [email, name, !!body.newsletter]
                );
                const b = rows[0];
                if (b.last_email_at && Date.now() - new Date(b.last_email_at).getTime() < 60000) {
                    return { ok: true, sent: false, reason: 'wait' };
                }
                await sendAuctionVerifyEmail({ to: email, name, token: b.token });
                await c.query('update bidders set last_email_at = now() where id = $1', [b.id]);
                return { ok: true, sent: true };
            });
            res.status(200).json(out);
            return;
        }

        if (body.action === 'verify') {
            const token = String(body.token || '').trim();
            const out = await withDb(async (c) => {
                const { rows } = await c.query(
                    `update bidders set verified_at = coalesce(verified_at, now())
                     where token = $1
                     returning email, name, newsletter, verified_at`,
                    [token]
                );
                if (!rows.length) return { ok: false, error: 'invalid_token' };
                const b = rows[0];
                // souhlas s newsletterem se plní až po prokázaném kliknutí z e-mailu
                if (b.newsletter) {
                    try {
                        await subscribeToNewsletter({ email: b.email, name: b.name });
                    } catch (e) {
                        console.error('newsletter subscribe failed for', b.email, '->', e.message);
                    }
                }
                return { ok: true, name: b.name };
            });
            res.status(200).json(out);
            return;
        }

        if (body.action === 'bid') {
            const token = String(body.token || '').trim();
            const slug = String(body.slug || '').trim();
            const amount = Math.round(Number(body.amount));
            if (!token || !slug || !Number.isFinite(amount)) {
                res.status(400).json({ ok: false, error: 'missing_fields' });
                return;
            }
            const out = await withDb(async (c) => {
                const settings = await getSettings(c);
                const test = isTest(settings);

                if (settings.mode === 'closed') return { ok: false, error: 'auction_closed' };
                if (settings.mode === 'live') {
                    const now = new Date();
                    if (now < new Date(settings.opens_at)) return { ok: false, error: 'not_open_yet' };
                    if (now > new Date(settings.closes_at)) return { ok: false, error: 'auction_closed' };
                }

                const { rows: brows } = await c.query(
                    'select id, email, name, verified_at from bidders where token = $1', [token]);
                if (!brows.length || !brows[0].verified_at) return { ok: false, error: 'not_verified' };
                const bidder = brows[0];

                const { rows: irows } = await c.query(
                    'select id, title, starting_price_czk, withdrawn from auction_items where slug = $1', [slug]);
                if (!irows.length || irows[0].withdrawn) return { ok: false, error: 'unknown_item' };
                const item = irows[0];

                if (amount > MAX_AMOUNT) return { ok: false, error: 'too_high' };

                // Souběh dvou příhozů na stejné dílo: advisory lock v transakci
                await c.query('begin');
                try {
                    await c.query('select pg_advisory_xact_lock(hashtext($1))', ['bid:' + slug]);
                    const { rows: top } = await c.query(
                        `select b.amount_czk, b.bidder_id, bd.email, bd.name
                         from bids b left join bidders bd on bd.id = b.bidder_id
                         where b.item_id = $1 and b.is_test = $2
                         order by b.amount_czk desc, b.created_at asc limit 1`,
                        [item.id, test]
                    );
                    const current = top.length ? top[0].amount_czk : null;
                    const minimum = current === null
                        ? item.starting_price_czk
                        : current + MIN_INCREMENT;
                    if (amount < minimum) {
                        await c.query('rollback');
                        return { ok: false, error: 'too_low', minimum };
                    }
                    await c.query(
                        'insert into bids (item_id, bidder_id, amount_czk, source, is_test) values ($1, $2, $3, $4, $5)',
                        [item.id, bidder.id, amount, 'online', test]
                    );
                    await c.query('commit');

                    // Přehozenému letí upozornění (nesmí shodit příhoz)
                    const prev = top.length ? top[0] : null;
                    if (prev && prev.bidder_id && prev.bidder_id !== bidder.id && prev.email) {
                        try {
                            await sendOutbidEmail({
                                to: prev.email, name: prev.name,
                                itemTitle: item.title, amount
                            });
                        } catch (e) {
                            console.error('outbid email failed for', prev.email, '->', e.message);
                        }
                    }
                    return { ok: true, top: amount, leading: true };
                } catch (e) {
                    await c.query('rollback').catch(() => {});
                    throw e;
                }
            });
            res.status(200).json(out);
            return;
        }

        res.status(400).json({ error: 'unknown_action' });
    } catch (e) {
        console.error('drazba api error from', clientIp(req), '->', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
