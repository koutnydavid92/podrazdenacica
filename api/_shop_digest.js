// Večerní souhrn objednávek Onanovánek pro Davida (jsem@podrazdenacica.cz).
// Co udělá: 1) založí zásilky v Zásilkovně pro zaplacené objednávky, které ji
// ještě nemají (ať jsou v mailu rovnou trasovací čísla a podací kódy),
// 2) dorovná stavy zásilek, 3) sestaví přehled: nové objednávky dne, co je
// k odeslání a dokdy (3 pracovní dny od zaplacení, české svátky), co čeká
// na osobní odběr, co se dnes podalo a doručilo, sklad a zájemci o ukázku.
//
// Spouští se z denního cronu (api/program-mail-followup.js?job=shop-digest,
// 21:00 Prahy) a ručně z adminu (akce shop_digest). Soubor s podtržítkem
// Vercel nevystavuje jako endpoint.

const packeta = require('./_packeta');
const { sendShopShippedEmail, sendShopDigestEmail, esc, czk } = require('./_email');

const SHIP_DAYS = 3;          // "balíme do 3 pracovních dnů" z obchodních podmínek
const PICKUP_HOLD_DAYS = 30;  // osobní odběr držíme měsíc

const SHIP_LABEL = {
    pickup_atelier: 'Osobní odběr',
    packeta_point_cz: 'Zásilkovna výdejní místo (ČR)',
    packeta_point_sk: 'Zásilkovna výdejní místo (SK)',
    packeta_home_cz: 'Zásilkovna na adresu (ČR)',
    packeta_home_sk: 'Zásilkovna na adresu (SK)'
};

// ---- Kalendář: pracovní dny v Česku ----

// Velikonoční neděle (Meeus/Jones/Butcher), z ní Velký pátek a pondělí
function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

function czHolidays(year) {
    const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
    const set = new Set(fixed.map(d => `${year}-${d}`));
    const easter = easterSunday(year);
    const iso = d => d.toISOString().slice(0, 10);
    set.add(iso(new Date(easter.getTime() - 2 * 86400000)));  // Velký pátek
    set.add(iso(new Date(easter.getTime() + 1 * 86400000)));  // Velikonoční pondělí
    return set;
}

function isBusinessDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !czHolidays(d.getUTCFullYear()).has(dateStr);
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Datum v Praze jako YYYY-MM-DD (pro "dnes" i pro den zaplacení)
function pragueDate(date) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(date instanceof Date ? date : new Date(date));
}

// Termín odeslání: N-tý pracovní den po dni zaplacení
function shipDeadline(createdAt) {
    let d = pragueDate(createdAt);
    let left = SHIP_DAYS;
    while (left > 0) {
        d = addDays(d, 1);
        if (isBusinessDay(d)) left--;
    }
    return d;
}

function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d, 10)}. ${parseInt(m, 10)}.`;
}

function fmtTracking(t) {
    return t ? 'Z ' + String(t).replace(/^Z/, '').replace(/^(\d{3})(\d{4})(\d{3})$/, '$1 $2 $3') : '';
}

function fmtConsign(c) {
    return c ? String(c).replace(/(\d{3})(?=\d)/g, '$1 ') : '';
}

// ---- Data ----

async function collect(client, today) {
    const q = async (sql, params) => (await client.query(sql, params || [])).rows;
    const todayPrague = `to_char(created_at at time zone 'Europe/Prague', 'YYYY-MM-DD') = $1`;
    return {
        newToday: await q(`select * from shop_orders where ${todayPrague} and status not in ('cancelled','refunded') order by order_no`, [today]),
        toShip: await q(`select * from shop_orders where status in ('paid','labeled') and shipping_method <> 'pickup_atelier' order by created_at`),
        pickups: await q(`select * from shop_orders where status = 'paid' and shipping_method = 'pickup_atelier' order by created_at`),
        shippedToday: await q(`select * from shop_orders where to_char(shipped_at at time zone 'Europe/Prague', 'YYYY-MM-DD') = $1 order by order_no`, [today]),
        deliveredToday: await q(`select * from shop_orders where to_char(picked_up_at at time zone 'Europe/Prague', 'YYYY-MM-DD') = $1 order by order_no`, [today]),
        samplesToday: (await q(`select count(*)::int n from shop_samples where ${todayPrague}`, [today]))[0].n,
        stock: (await q(`select stock, sold from shop_stock where product = 'onanovanky'`))[0] || { stock: 0, sold: 0 },
        soldTotal: (await q(`select coalesce(sum(quantity),0)::int n from shop_orders where status not in ('cancelled','refunded')`))[0].n
    };
}

// ---- Sestavení mailu ----

function orderLine(o, extra) {
    const who = esc(o.name || '?');
    const what = `${o.quantity} ks${o.gift_bag ? ' + taška' : ''}, ${czk(o.total_czk)}`;
    return `<tr>
        <td style="padding:7px 0;border-top:1px solid #2A2A2A;color:#F5F5F5;font-size:14px;vertical-align:top;white-space:nowrap;"><b>č. ${o.order_no}</b></td>
        <td style="padding:7px 8px;border-top:1px solid #2A2A2A;color:#CCCCCC;font-size:14px;vertical-align:top;">${who}<br><span style="color:#888888;font-size:12px;">${what}</span></td>
        <td style="padding:7px 0;border-top:1px solid #2A2A2A;color:#CCCCCC;font-size:13px;vertical-align:top;">${extra}</td>
    </tr>`;
}

function section(title, rowsHtml, emptyText) {
    return `<h2 style="color:#FE45E8;font-size:15px;margin:22px 0 6px;">${title}</h2>` + (rowsHtml
        ? `<table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>`
        : `<p style="color:#888888;font-size:13px;margin:0;">${emptyText}</p>`);
}

function compose(data, today, created, synced) {
    const late = data.toShip.filter(o => shipDeadline(o.created_at) < today);
    const dueToday = data.toShip.filter(o => shipDeadline(o.created_at) === today);

    // Předmět: to nejdůležitější na jeden pohled
    const parts = [];
    if (data.toShip.length) parts.push(`${data.toShip.length} k odeslání${late.length ? ` (${late.length} po termínu)` : dueToday.length ? ` (${dueToday.length} dnes)` : ''}`);
    if (data.pickups.length) parts.push(`${data.pickups.length} k odběru`);
    if (data.newToday.length) parts.push(`${data.newToday.length} nové`);
    const subject = `📦 Onanovánky ${fmtDate(today)}: ${parts.length ? parts.join(', ') : 'klid, nic k řešení'}`;

    const shipRows = data.toShip.map(o => {
        const dl = shipDeadline(o.created_at);
        const status = dl < today ? `<b style="color:#E74C3C;">PO TERMÍNU (${fmtDate(dl)})</b>`
            : dl === today ? `<b style="color:#F1C40F;">odeslat DNES</b>`
            : `odeslat do <b style="color:#F5F5F5;">${fmtDate(dl)}</b>`;
        const where = o.packeta_point_id
            ? `${esc(o.packeta_point_name || '')}${o.packeta_point_address ? ', ' + esc(o.packeta_point_address) : ''}`
            : esc([o.address_line1, [o.address_zip, o.address_city].filter(Boolean).join(' '), o.address_country].filter(Boolean).join(', '));
        const codes = o.packeta_tracking
            ? `trasovací <b style="color:#F5F5F5;">${esc(fmtTracking(o.packeta_tracking))}</b>${o.packeta_consign_code ? `<br>podací kód Z-BOX <b style="color:#F5F5F5;letter-spacing:1px;">${esc(fmtConsign(o.packeta_consign_code))}</b>` : ''}`
            : `<span style="color:#E74C3C;">zásilka se nepovedla založit, zkus v adminu</span>`;
        return orderLine(o, `${status}<br>${esc(SHIP_LABEL[o.shipping_method] || o.shipping_method)}<br>${where}<br>${codes}${o.note ? `<br><i style="color:#F1C40F;">„${esc(o.note)}“</i>` : ''}`);
    }).join('');

    const pickupRows = data.pickups.map(o => {
        const paid = pragueDate(o.created_at);
        const age = daysBetween(paid, today);
        const left = PICKUP_HOLD_DAYS - age;
        const hold = left <= 0 ? `<b style="color:#E74C3C;">lhůta vypršela</b>` : left <= 7 ? `<b style="color:#F1C40F;">držíme ještě ${left} dní</b>` : `držíme ještě ${left} dní`;
        return orderLine(o, `zaplaceno ${fmtDate(paid)} (před ${age} dny), ${hold}${o.phone ? `<br>${esc(o.phone)}` : ''}<br>${esc(o.email || '')}${o.note ? `<br><i style="color:#F1C40F;">„${esc(o.note)}“</i>` : ''}`);
    }).join('');

    const newRows = data.newToday.map(o => orderLine(o, `${esc(SHIP_LABEL[o.shipping_method] || o.shipping_method)}${o.note ? `<br><i style="color:#F1C40F;">„${esc(o.note)}“</i>` : ''}`)).join('');
    const shippedRows = data.shippedToday.map(o => orderLine(o, `podáno Zásilkovně, ${esc(fmtTracking(o.packeta_tracking))}`)).join('');
    const deliveredRows = data.deliveredToday.map(o => orderLine(o, o.shipping_method === 'pickup_atelier' ? 'vyzvednuto v ateliéru' : 'doručeno')).join('');

    const createdNote = created.length
        ? `<p style="color:#CCCCCC;font-size:13px;margin:0 0 8px;">Dnes večer jsem založil ${created.length} ${created.length === 1 ? 'zásilku' : created.length < 5 ? 'zásilky' : 'zásilek'} v Zásilkovně: ${created.map(x => 'č. ' + x.order_no + (x.error ? ' (chyba: ' + esc(x.error) + ')' : '')).join(', ')}.</p>`
        : '';

    const bodyHtml = `
        ${createdNote}
        ${section(`K odeslání (${data.toShip.length})`, shipRows, 'Nic nečeká na balení. Mňau.')}
        ${section(`Osobní odběr, čeká (${data.pickups.length})`, pickupRows, 'Nikdo nečeká na vyzvednutí.')}
        ${section(`Nové objednávky dnes (${data.newToday.length})`, newRows, 'Dnes nic nepřišlo.')}
        ${(data.shippedToday.length || data.deliveredToday.length) ? section('Dnes hotovo', shippedRows + deliveredRows, '') : ''}
        <p style="color:#888888;font-size:12px;line-height:1.7;margin:22px 0 0;">
            Sklad: <b style="color:#CCCCCC;">${data.stock.stock} ks</b> · prodáno celkem ${data.soldTotal} ks
            · ukázky na mail dnes: ${data.samplesToday}${synced.length ? ` · stavy ze Zásilkovny: ${synced.map(x => 'č. ' + x.order_no + ' ' + (x.to === 'shipped' ? 'podáno' : 'doručeno')).join(', ')}` : ''}
        </p>
        <div style="text-align:center;margin:24px 0 0;">
            <a href="https://www.podrazdenacica.cz/onanovanky-admin" style="display:inline-block;background:#FE45E8;color:#0D0D0D;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:50px;text-decoration:none;">Otevřít admin</a>
        </div>`;

    const textLines = [
        `Onanovánky ${fmtDate(today)}`,
        '',
        `K ODESLÁNÍ (${data.toShip.length}):`,
        ...data.toShip.map(o => {
            const dl = shipDeadline(o.created_at);
            return `  č. ${o.order_no} ${o.name}, ${o.quantity} ks, ${dl < today ? 'PO TERMÍNU' : dl === today ? 'DNES' : 'do ' + fmtDate(dl)}, ${o.packeta_point_name || o.address_city || ''}, ${fmtTracking(o.packeta_tracking)}${o.packeta_consign_code ? ', Z-BOX ' + fmtConsign(o.packeta_consign_code) : ''}`;
        }),
        '',
        `OSOBNÍ ODBĚR (${data.pickups.length}):`,
        ...data.pickups.map(o => `  č. ${o.order_no} ${o.name}, ${o.quantity} ks, zaplaceno ${fmtDate(pragueDate(o.created_at))}`),
        '',
        `NOVÉ DNES (${data.newToday.length}):`,
        ...data.newToday.map(o => `  č. ${o.order_no} ${o.name}, ${o.quantity} ks, ${czk(o.total_czk)}`),
        '',
        `Sklad ${data.stock.stock} ks, prodáno ${data.soldTotal} ks, ukázky dnes ${data.samplesToday}.`,
        'Admin: https://www.podrazdenacica.cz/onanovanky-admin'
    ];

    const hasContent = data.toShip.length || data.pickups.length || data.newToday.length
        || data.shippedToday.length || data.deliveredToday.length || data.samplesToday;
    return { subject, bodyHtml, text: textLines.join('\n'), hasContent: Boolean(hasContent), late: late.length, dueToday: dueToday.length };
}

// Hlavní běh. opts.send = false jen sestaví (pro náhled), true i odešle.
async function runShopDigest(client, opts) {
    const o = Object.assign({ send: true, createPackets: true }, opts || {});
    const today = pragueDate(new Date());
    let created = [];
    let synced = [];
    if (o.createPackets) {
        try { created = await packeta.createPendingPackets(client); }
        catch (e) { console.error('digest: create packets failed', e.message); }
    }
    try { synced = await packeta.syncStatuses(client, sendShopShippedEmail, 100); }
    catch (e) { console.error('digest: sync failed', e.message); }
    const data = await collect(client, today);
    const mail = compose(data, today, created, synced);
    let sent = false;
    if (o.send && (mail.hasContent || o.force)) {
        await sendShopDigestEmail({ subject: mail.subject, heading: `Souhrn obchodu, ${fmtDate(today)}`, bodyHtml: mail.bodyHtml, text: mail.text });
        sent = true;
    }
    return {
        ok: true, today, sent, subject: mail.subject, has_content: mail.hasContent,
        to_ship: data.toShip.length, late: mail.late, due_today: mail.dueToday, pickups: data.pickups.length,
        new_today: data.newToday.length, created, synced
    };
}

module.exports = { runShopDigest, shipDeadline, isBusinessDay, czHolidays, pragueDate, collect, compose };
