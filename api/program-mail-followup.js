// Dodatečné poslání mailu "Program odhalen" lidem, kteří se do listu
// "ČAF 2026 - účastníci" dostali až PO rozeslání kampaně (25. 8. 2026).
// Spouští Vercel cron denně v 08:00 UTC (10:00 Prahy); reálně posílá jen
// v den festu 28. 8. 2026. Ručně jde spustit POSTem s ADMIN_PIN.
//
// Pojistka proti dvojímu poslání: po odeslání dostane kontakt tag
// SENT_TAG a příště se přeskočí. Kdo byl v listu před kampaní, má
// subscribed_at pod CUTOFF a nedostane nic.

const { SUBJECT, buildHtml, buildText } = require('./_program_mail');
const { pinEquals, withDb } = require('./_lib');

const LIST_ID = 3;
// Kampaň se rozesílala 25. 8. 2026 ~04:05 UTC; příjemci se ale zamkli už
// při zařazení do fronty (~03:39). Hranice s rezervou před tím.
const CUTOFF = '2026-08-25T03:35:00';
const SENT_TAG = 'caf-program-mail-dodatecne';
const RUN_DATE = '2026-08-28'; // cron posílá jen v den festu
const MAX_SENDS = 60; // pojistka proti nečekaně velké dávce

async function ecomail(method, path, payload) {
    const res = await fetch('https://api2.ecomailapp.cz' + path, {
        method,
        headers: { key: process.env.ECOMAIL_API_KEY, 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ecomail ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function newSubscribers() {
    const out = [];
    for (let page = 1; page <= 50; page++) {
        const d = await ecomail('GET', `/lists/${LIST_ID}/subscribers?per_page=100&page=${page}`);
        for (const s of d.data || []) {
            if (s.status === 1 && String(s.subscribed_at || '') > CUTOFF) out.push(s);
        }
        if (!d.next_page_url) break;
    }
    return out;
}

async function hasSentTag(email) {
    try {
        const d = await ecomail('GET', `/lists/${LIST_ID}/subscriber/${encodeURIComponent(email)}`);
        const tags = (d.subscriber || d || {}).tags || [];
        return tags.includes(SENT_TAG);
    } catch (e) {
        // Při nejistotě raději neposlat (dvojitý mail je horší než chybějící,
        // tenhle bonusový kanál není kritický).
        console.error('tag check failed for', email, e.message);
        return true;
    }
}

async function markSent(email) {
    await ecomail('POST', `/lists/${LIST_ID}/subscribe`, {
        subscriber_data: { email, tags: [SENT_TAG] },
        trigger_autoresponders: false,
        trigger_notification: false,
        update_existing: true,
        resubscribe: false,
        skip_confirmation: true
    });
}

async function ticketsForEmail(c, email) {
    const { rows } = await c.query(
        `select qr_token, ticket_no, type from tickets
         where lower(email) = lower($1) and status <> 'cancelled'
         order by ticket_no`, [email]);
    return rows;
}

async function sendProgramMail(sub, tickets) {
    await ecomail('POST', '/transactional/send-message', {
        message: {
            subject: SUBJECT,
            from_name: 'Podrážděná číča',
            from_email: 'jsem@cicoviny.podrazdenacica.cz',
            reply_to: 'jsem@podrazdenacica.cz',
            to: [{ email: sub.email, name: [sub.name, sub.surname].filter(Boolean).join(' ') }],
            html: buildHtml(tickets),
            text: buildText(tickets)
        }
    });
}

module.exports = async (req, res) => {
    const isCron = String(req.headers['user-agent'] || '').startsWith('vercel-cron');
    const isAdmin = req.method === 'POST' && pinEquals((req.body || {}).pin, process.env.ADMIN_PIN);
    const today = new Date().toISOString().slice(0, 10);

    if (!isCron && !isAdmin) {
        // bez oprávnění jen anonymní náhled počtů, nic se neposílá
        try {
            const subs = await newSubscribers();
            res.status(200).json({ dry_run: true, novych_od_kampane: subs.length });
        } catch (e) {
            res.status(500).json({ error: 'server_error' });
        }
        return;
    }
    if (isCron && !isAdmin && today !== RUN_DATE) {
        res.status(200).json({ skipped: true, reason: `cron posílá až ${RUN_DATE}`, today });
        return;
    }
    try {
        const subs = (await newSubscribers()).slice(0, MAX_SENDS);
        const sent = [];
        const skipped = [];
        await withDb(async (c) => {
            for (const sub of subs) {
                if (await hasSentTag(sub.email)) {
                    skipped.push(sub.email);
                    continue;
                }
                const tickets = await ticketsForEmail(c, sub.email);
                await sendProgramMail(sub, tickets);
                await markSent(sub.email);
                sent.push(sub.email);
            }
        });
        console.log('program-mail-followup:', sent.length, 'posláno,', skipped.length, 'přeskočeno');
        res.status(200).json({ ok: true, sent: sent.length, skipped: skipped.length });
    } catch (e) {
        console.error('program-mail-followup error:', e.message);
        res.status(500).json({ error: 'server_error' });
    }
};
