// Odesílání e-mailů přes Ecomail transakční API + šablona vstupenky.
const BASE_URL = 'https://www.podrazdenacica.cz';
// Odesílá se z domény ověřené v Ecomailu; odpovědi chodí na hlavní adresu.
const FROM_EMAIL = 'jsem@cicoviny.podrazdenacica.cz';
const REPLY_TO = 'jsem@podrazdenacica.cz';
const FROM_NAME = 'Podrážděná číča';
const ECOMAIL_LIST_ID = 2; // "Newsletter Číča" - marketing, jen se souhlasem
// "ČAF 2026 - účastníci" - provozní info k akci (kde, kdy, změna programu).
// Není to newsletter: chodí sem každý, kdo drží vstupenku, protože informace
// k akci patří ke koupené/přijaté vstupence. Marketing zůstává na listu 2.
const ECOMAIL_EVENT_LIST_ID = 3;

async function ecomail(path, payload) {
    const res = await fetch('https://api2.ecomailapp.cz' + path, {
        method: 'POST',
        headers: {
            'key': process.env.ECOMAIL_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Ecomail ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// HTML e-mailu se vstupenkami (jeden nákup = jeden mail, QR pro každou vstupenku)
// greetingName = oslovení v 5. pádě (máme jen u VIP); bez něj zdravíme neutrálně
function ticketEmailHtml({ greetingName, tickets, isVip }) {
    const greeting = greetingName ? `Čaf ${esc(greetingName)}` : 'Čaf';
    const plural = tickets.length === 1 ? 'vstupenka'
        : (tickets.length <= 4 ? 'vstupenky' : 'vstupenek');

    const ticketBlocks = tickets.map(t => `
        <div style="background:#FFFFFF;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
            <img src="${BASE_URL}/api/qr?token=${t.qr_token}" alt="QR kód vstupenky"
                 width="240" height="240" style="display:block;margin:0 auto;width:240px;height:240px;">
            <p style="color:#0D0D0D;font-size:14px;margin:12px 0 4px;font-weight:bold;">
                ${isVip ? 'VIP vstupenka' : 'Vstupenka'}${tickets.length > 1 ? ' ' + t.ticket_no + '/' + tickets.length : ''}
            </p>
            <p style="color:#555555;font-size:12px;margin:0;">
                Nejde zobrazit QR? <a href="${BASE_URL}/cica-art-fest/vstupenka?t=${t.qr_token}" style="color:#FE45E8;">Otevři vstupenku na webu</a>.
            </p>
        </div>`).join('');

    return `<!DOCTYPE html>
<html lang="cs"><body style="margin:0;padding:0;background:#0D0D0D;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;">
    <div style="text-align:center;margin-bottom:24px;">
        <img src="${BASE_URL}/images/logo.png" alt="Podrážděná číča" width="90" style="width:90px;">
    </div>
    <div style="background:#111111;border:1px solid #FE45E8;border-radius:16px;padding:32px 24px;">
        <h1 style="color:#F5F5F5;font-size:26px;margin:0 0 12px;text-align:center;">
            ${greeting}, ${isVip ? 'tady je tvůj VIP vstup' : 'máš to'}. 🖤
        </h1>
        <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0 0 8px;">
            Číča Art Fest &middot; 28. 8. 2026 &middot; co.labs_park, Kounicova 20, Brno
        </p>
        <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0 0 20px;">
            ${tickets.length > 1 ? `Uvnitř najdeš ${tickets.length} ${plural}, každou s vlastním QR kódem. Rozdej je smečce.` : ''}
            U vchodu ukážeš QR kód, dostaneš pásku a zbytek večera je na tobě.
        </p>
        ${ticketBlocks}
        <p style="color:#CCCCCC;font-size:14px;line-height:1.6;margin:20px 0 0;">
            Hot kocs všude. Na plátně i na mole. Možná i na mol. Hudba z ženských prsou,
            stand-up i dražba, u který budou ruce hore, jak když se babi zeptá, kdo chce
            přidat. Program postupně odhalujeme
            na <a href="${BASE_URL}/cica-art-fest" style="color:#FE45E8;">webu</a>
            a <a href="https://www.instagram.com/podrazdena_cica/" style="color:#FE45E8;">Instagramu</a>.
        </p>
        <p style="color:#CCCCCC;font-size:14px;margin:16px 0 0;">
            Nech si mě v hlavě. Mňau ₍^. .^₎⟆
        </p>
    </div>
    <p style="color:#666666;font-size:11px;text-align:center;margin:20px 0 0;">
        Tenhle mail ti přišel, protože máš vstupenku na Číča Art Fest.
        Vstupenka je nevratná, ale přenosná.
    </p>
</div>
</body></html>`;
}

function ticketEmailText({ tickets, isVip }) {
    const lines = tickets.map(t =>
        `${isVip ? 'VIP vstupenka' : 'Vstupenka'} ${t.ticket_no}: ${BASE_URL}/cica-art-fest/vstupenka?t=${t.qr_token}`);
    return 'Tvoje vstupenka na Číča Art Fest (28. 8. 2026, co.labs_park, Brno):\n\n'
        + lines.join('\n')
        + '\n\nU vchodu ukážeš QR kód a dostaneš pásku. Mňau.';
}

// Pošle e-mail se vstupenkami. tickets: [{qr_token, ticket_no}]
// greetingName: oslovení v 5. pádě (jen VIP), name: celé jméno adresáta
async function sendTicketEmail({ to, name, greetingName, tickets, isVip }) {
    return ecomail('/transactional/send-message', {
        message: {
            subject: isVip
                ? 'Tvůj VIP vstup na Číča Art Fest 🖤'
                : 'Tvoje vstupenka na Číča Art Fest 🖤',
            from_name: FROM_NAME,
            from_email: FROM_EMAIL,
            reply_to: REPLY_TO,
            to: [{ email: to, name: name || '' }],
            html: ticketEmailHtml({ greetingName, tickets, isVip }),
            text: ticketEmailText({ tickets, isVip })
        }
    });
}

// Přihlásí kontakt do listu (jen při zaškrtnutém souhlasu)
async function subscribeToNewsletter({ email, name }) {
    const parts = String(name || '').trim().split(/\s+/);
    return ecomail(`/lists/${ECOMAIL_LIST_ID}/subscribe`, {
        subscriber_data: {
            email,
            name: parts[0] || '',
            surname: parts.slice(1).join(' ') || '',
            tags: ['cica-art-fest']
        },
        trigger_autoresponders: false,
        update_existing: true,
        resubscribe: false
    });
}

// Zapíše držitele vstupenky do účastnického listu. Bez potvrzovacího mailu
// (skip_confirmation) - jde o provozní kanál k zakoupené vstupence, ne
// o marketingový newsletter. Volá se při vydání vstupenky, ne z guestlistu:
// dřív se do Ecomailu dostal jen ten, kdo navíc zaškrtl souhlas, takže
// polovina VIP hostů zůstala mimo dosah informací k festu.
async function subscribeToEventList({ email, name, isVip }) {
    const parts = String(name || '').trim().split(/\s+/);
    return ecomail(`/lists/${ECOMAIL_EVENT_LIST_ID}/subscribe`, {
        subscriber_data: {
            email,
            name: parts[0] || '',
            surname: parts.slice(1).join(' ') || '',
            tags: ['caf-2026-ucastnik', isVip ? 'caf-vip' : 'caf-kupujici']
        },
        trigger_autoresponders: false,
        trigger_notification: false,
        update_existing: true,
        resubscribe: false,
        skip_confirmation: true
    });
}

// Zápis do Ecomailu nesmí shodit odeslání vstupenky - vstupenka je důležitější.
// Selhání ale musí být vidět v logu, ať se neztratí potichu jako dřív.
async function subscribeToEventListSafe({ email, name, isVip }) {
    if (!email) return false;
    try {
        await subscribeToEventList({ email, name, isVip });
        return true;
    } catch (e) {
        console.error('event list subscribe failed for', email, '->', e.message);
        return false;
    }
}

// ============================================================
// Dražba – e-maily (ověření, přehození, výhra)
// ============================================================

// Společný obal dražebních mailů ve stylu vstupenek
function auctionShell({ heading, bodyHtml, footNote }) {
    return `<!DOCTYPE html>
<html lang="cs"><body style="margin:0;padding:0;background:#0D0D0D;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;">
    <div style="text-align:center;margin-bottom:24px;">
        <img src="${BASE_URL}/images/logo.png" alt="Podrážděná číča" width="90" style="width:90px;">
    </div>
    <div style="background:#111111;border:1px solid #FE45E8;border-radius:16px;padding:32px 24px;">
        <h1 style="color:#F5F5F5;font-size:24px;margin:0 0 16px;text-align:center;">${heading}</h1>
        ${bodyHtml}
        <p style="color:#CCCCCC;font-size:14px;margin:20px 0 0;">
            Nech si mě v hlavě. Mňau ₍^. .^₎⟆
        </p>
    </div>
    <p style="color:#666666;font-size:11px;text-align:center;margin:20px 0 0;">${footNote}</p>
</div>
</body></html>`;
}

function auctionButton(href, label) {
    return `<div style="text-align:center;margin:24px 0;">
        <a href="${href}" style="display:inline-block;background:#FE45E8;color:#0D0D0D;
           font-weight:bold;font-size:16px;padding:14px 32px;border-radius:50px;
           text-decoration:none;">${label}</a>
    </div>`;
}

// Ověřovací odkaz po registraci do dražby
async function sendAuctionVerifyEmail({ to, name, token }) {
    const link = `${BASE_URL}/drazba-live?vstup=${token}`;
    return ecomail('/transactional/send-message', {
        message: {
            subject: 'Potvrď vstup do dražby 🖤',
            from_name: FROM_NAME,
            from_email: FROM_EMAIL,
            reply_to: REPLY_TO,
            to: [{ email: to, name: name || '' }],
            html: auctionShell({
                heading: `Čaf${name ? ' ' + esc(String(name).split(/\s+/)[0]) : ''}, ještě klik a přihazuješ.`,
                bodyHtml: `
                    <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0;">
                        Tímhle tlačítkem potvrdíš svůj e-mail a můžeš se vrhnout
                        na tichou dražbu Číča Art Festu.
                    </p>
                    ${auctionButton(link, 'Jdu přihazovat')}
                    <p style="color:#888888;font-size:12px;line-height:1.6;text-align:center;margin:0;">
                        Nejde tlačítko? Zkopíruj si odkaz: ${link}
                    </p>`,
                footNote: 'Tenhle mail ti přišel, protože ses registroval(a) do dražby na Číča Art Festu. Pokud jsi to nebyl(a) ty, klidně ho ignoruj.'
            }),
            text: `Potvrď vstup do dražby Číča Art Festu: ${link}\n\nPokud jsi to nebyl(a) ty, mail ignoruj. Mňau.`
        }
    });
}

// Upozornění: někdo tě přehodil
async function sendOutbidEmail({ to, name, itemTitle, amount }) {
    const link = `${BASE_URL}/drazba-live`;
    return ecomail('/transactional/send-message', {
        message: {
            subject: `Přehodili tě! ${itemTitle} už není tvoje 😾`,
            from_name: FROM_NAME,
            from_email: FROM_EMAIL,
            reply_to: REPLY_TO,
            to: [{ email: to, name: name || '' }],
            html: auctionShell({
                heading: 'Au. Někdo přihodil víc.',
                bodyHtml: `
                    <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0;">
                        Dílo <b style="color:#F5F5F5;">${esc(itemTitle)}</b> ti právě
                        někdo vyfoukl nabídkou <b style="color:#FE45E8;">${amount.toLocaleString('cs-CZ')} Kč</b>.
                        Necháš si to líbit?
                    </p>
                    ${auctionButton(link, 'Přehodit zpátky')}`,
                footNote: 'Tenhle mail ti přišel, protože přihazuješ v dražbě na Číča Art Festu.'
            }),
            text: `Dílo ${itemTitle} ti někdo přehodil nabídkou ${amount} Kč. Přihoď zpátky: ${link}\n\nMňau.`
        }
    });
}

// Zpráva vítězi po skončení dražby (posílá se z adminu)
async function sendWinnerEmail({ to, name, itemTitle, amount, qrUrl }) {
    return ecomail('/transactional/send-message', {
        message: {
            subject: `Vyhráls dražbu: ${itemTitle} je tvoje! 🖤`,
            from_name: FROM_NAME,
            from_email: FROM_EMAIL,
            reply_to: REPLY_TO,
            to: [{ email: to, name: name || '' }],
            html: auctionShell({
                heading: `Gratulace${name ? ', ' + esc(String(name).split(/\s+/)[0]) : ''}. Máš to.`,
                bodyHtml: `
                    <p style="color:#CCCCCC;font-size:15px;line-height:1.6;text-align:center;margin:0 0 16px;">
                        Dílo <b style="color:#F5F5F5;">${esc(itemTitle)}</b> je tvoje
                        za <b style="color:#FE45E8;">${amount.toLocaleString('cs-CZ')} Kč</b>.
                    </p>
                    ${qrUrl ? `<div style="background:#FFFFFF;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
                        <img src="${qrUrl}" alt="QR platba" width="240" height="240" style="display:block;margin:0 auto;width:240px;height:240px;">
                        <p style="color:#555555;font-size:12px;margin:12px 0 0;">Naskenuj v bankovní appce</p>
                    </div>` : ''}
                    <p style="color:#CCCCCC;font-size:14px;line-height:1.6;margin:0;">
                        Zaplatit můžeš QR kódem, nebo převodem na účet
                        <b style="color:#F5F5F5;">1952337019/3030</b> (do zprávy napiš název díla).
                        Peníze musí dorazit nejpozději 31. 8. 2026, jinak dílo putuje
                        k dalšímu v pořadí. Předání domluvíme e-mailem.
                    </p>`,
                footNote: 'Tenhle mail ti přišel, protože jsi vyhrál(a) dražbu na Číča Art Festu. Pravidla: ' + BASE_URL + '/drazba-pravidla'
            }),
            text: `Vyhráls dražbu na Číča Art Festu: ${itemTitle} za ${amount} Kč.\n\nZaplať převodem na 1952337019/3030 (do zprávy název díla) nejpozději do 31. 8. 2026.\n\nMňau.`
        }
    });
}

module.exports = {
    sendTicketEmail, subscribeToNewsletter,
    subscribeToEventList, subscribeToEventListSafe,
    sendAuctionVerifyEmail, sendOutbidEmail, sendWinnerEmail
};
