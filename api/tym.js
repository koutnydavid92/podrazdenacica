// POST /api/tym - týmová nástěnka zpětné vazby (stránka /tym).
// PIN se ověřuje proti TEAM_PIN nebo ADMIN_PIN (env proměnné).
// Akce:
//   {pin, action:'overview', person}                 - kartičky + srdíčka (a doimport dotazníku)
//   {pin, action:'add_card', title, description, author, category, kind}
//   {pin, action:'toggle_heart', card_id, person}    - srdíčko dát / vzít (1 na osobu a kartu)
//   {pin, action:'set_status', card_id, status}      - novy / resime / hotovo / nedame
const { withDb, pinEquals, clientIp, pinRateLimited, recordPinFailure } = require('./_lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['povedlo', 'zlepsit', 'napad'];
const CATEGORIES = ['program', 'jidlo', 'organizace', 'prostor', 'marketing', 'jine'];
const STATUSES = ['novy', 'resime', 'hotovo', 'nedame'];

function pinOk(pin) {
    return [process.env.TEAM_PIN, process.env.ADMIN_PIN]
        .filter(Boolean).some(p => pinEquals(pin, p));
}

// Jméno pro srdíčka: normalizované, ať "Katka" a "katka " je jeden člověk
function cleanPerson(v) {
    const p = String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    return p.length >= 2 && p.length <= 60 ? p : null;
}

const clip = (v, max) => String(v || '').trim().slice(0, max) || null;

// Nové odpovědi z dotazníku se na nástěnku přidávají samy.
// Idempotentní přes feedback_ref, opakované volání nic nezdvojí.
async function syncFromFeedback(c) {
    await c.query(`
        insert into team_cards (kind, title, description, author, source, feedback_ref, created_at)
        select 'zlepsit',
               left(regexp_replace(trim(f.improve), '\\s+', ' ', 'g'), 90)
                 || case when char_length(regexp_replace(trim(f.improve), '\\s+', ' ', 'g')) > 90 then '…' else '' end,
               trim(f.improve), 'Návštěvníci (dotazník)', 'navstevnici', 'fb:' || f.id || ':improve', f.created_at
        from caf_feedback f
        where f.improve is not null and trim(f.improve) <> ''
        on conflict (feedback_ref) do nothing`);
    await c.query(`
        insert into team_cards (kind, title, description, author, source, feedback_ref, created_at)
        select 'povedlo',
               left(regexp_replace(trim(f.quote), '\\s+', ' ', 'g'), 90)
                 || case when char_length(regexp_replace(trim(f.quote), '\\s+', ' ', 'g')) > 90 then '…' else '' end,
               trim(f.quote),
               case when f.quote_public then coalesce(f.quote_author, 'Anonymní číča') else 'Návštěvníci (dotazník)' end,
               'navstevnici', 'fb:' || f.id || ':quote', f.created_at
        from caf_feedback f
        where f.quote is not null and trim(f.quote) <> ''
        on conflict (feedback_ref) do nothing`);
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
            if (!pinOk(body.pin)) {
                await recordPinFailure(c, ip, 'tym');
                return { __status: 401, error: 'bad_pin' };
            }

            if (body.action === 'add_card') {
                const title = clip(body.title, 120);
                if (!title) return { ok: false, error: 'missing_title' };
                const kind = KINDS.includes(body.kind) ? body.kind : 'napad';
                const category = CATEGORIES.includes(body.category) ? body.category : null;
                const { rows } = await c.query(
                    `insert into team_cards (kind, title, description, author, source, category)
                     values ($1, $2, $3, $4, 'tym', $5) returning id`,
                    [kind, title, clip(body.description, 2000), clip(body.author, 60), category]
                );
                return { ok: true, id: rows[0].id };
            }

            if (body.action === 'toggle_heart') {
                const person = cleanPerson(body.person);
                const cardId = String(body.card_id || '').trim();
                if (!person) return { ok: false, error: 'missing_person' };
                if (!UUID_RE.test(cardId)) return { ok: false, error: 'bad_card' };
                const del = await c.query(
                    'delete from team_hearts where card_id = $1 and person = $2',
                    [cardId, person]
                );
                if (del.rowCount === 0) {
                    await c.query(
                        'insert into team_hearts (card_id, person) values ($1, $2) on conflict do nothing',
                        [cardId, person]
                    );
                }
                const { rows } = await c.query(
                    'select count(*)::int as n from team_hearts where card_id = $1', [cardId]);
                return { ok: true, hearts: rows[0].n, mine: del.rowCount === 0 };
            }

            if (body.action === 'set_status') {
                const cardId = String(body.card_id || '').trim();
                if (!UUID_RE.test(cardId)) return { ok: false, error: 'bad_card' };
                if (!STATUSES.includes(body.status)) return { ok: false, error: 'bad_status' };
                await c.query('update team_cards set status = $2 where id = $1', [cardId, body.status]);
                return { ok: true };
            }

            // overview (výchozí)
            await syncFromFeedback(c);
            const person = cleanPerson(body.person);
            const { rows: cards } = await c.query(
                `select c.id, c.kind, c.title, c.description, c.author, c.source,
                        c.category, c.status, c.created_at,
                        coalesce(h.n, 0) as hearts,
                        case when $1::text is null then false
                             else exists (select 1 from team_hearts
                                          where card_id = c.id and person = $1) end as mine
                 from team_cards c
                 left join lateral (
                     select count(*)::int as n from team_hearts where card_id = c.id
                 ) h on true
                 order by coalesce(h.n, 0) desc, c.created_at desc`,
                [person]
            );
            return { ok: true, cards };
        });
        const status = out.__status || 200;
        delete out.__status;
        res.status(status).json(out);
    } catch (e) {
        console.error('tym error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
