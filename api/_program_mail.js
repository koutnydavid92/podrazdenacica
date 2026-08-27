// Obsah mailu "Program odhalen" pro dodatečné poslání novým držitelům
// vstupenek (transakčně, proto bez odhlašovacího merge tagu kampaní).
// Časy drž v synchronu s programem na /cica-art-fest.

const SUBJECT = 'Program odhalen. Jako tvoje máma. 🐱';

const PROGRAM = [
    ['15:30', 'Otevíráme brány. Registrace, welcome drink do pacičky, tetovací studio Breberka Tattoo a Číča Market plný knih, svíček a umča'],
    ['15:45', 'Komentovaná vernisáž série Královny Brno-venkov'],
    ['16:20', 'Zahájení. Držte si klobouky. A hůlky.'],
    ['16:30', 'Hudební soubor Vážky'],
    ['17:10', 'Panelová diskuze „Všechno je to v hlavě a v číči“'],
    ['18:05', 'Stand-up Terezy Bonaventurové'],
    ['18:35', 'Krupicafaja a její lidové rap'],
    ['19:30', 'Módní přehlídka: devět žen, devět silných příběhů'],
    ['20:10', 'Vrchol dražby umění a artefaktů'],
    ['20:40', 'Jak vznikaly Onanovánky? Komentovka v ateliéru'],
    ['21:10', 'Grande finale: drag queen Miss Petty'],
    ['22:00', 'Noční klid. A lov dalších příběhů někde v Brně'],
];

const rows = PROGRAM.map(([t, txt]) => `
                <tr><td style="color:#FE45E8; font-weight:bold; white-space:nowrap; vertical-align:top; padding:6px 14px 6px 0;">${t}</td>
                    <td style="padding:6px 0;">${txt}</td></tr>`).join('');

const HTML = `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${SUBJECT}</title></head>
<body style="margin:0; padding:0; background-color:#0D0D0D;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Vernisáž, panelovka o číči, stand-up, lidové rap, molo, dražba a Miss Petty. Páteček, pohodička, pártoška.
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0D0D0D;">
<tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">
        <tr><td style="padding:0 8px 28px 8px;" align="center">
            <a href="https://www.podrazdenacica.cz/cica-art-fest" style="text-decoration:none;">
                <img src="https://www.podrazdenacica.cz/images/logo.png" width="72" alt="Podrážděná číča" style="display:block; border:0; margin:0 auto 16px auto;">
            </a>
            <div style="font-family:Arial Black, Arial, Helvetica, sans-serif; font-weight:900; font-size:28px; line-height:1.2; color:#F5F5F5;">
                Číča Art Fest<span style="color:#FE45E8;">.</span>
            </div>
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#CCCCCC; padding-top:8px;">
                pátek 28. 8. 2026 · 15:30–22:00 · co.labs_park, Kounicova 20, Brno
            </div>
        </td></tr>
        <tr><td style="background-color:#111111; border:1px solid #2A2A2A; border-radius:14px; padding:28px;">
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:16px; line-height:1.6; color:#F5F5F5;">
                <p style="margin:0 0 16px 0;">Čaf číčo,</p>
                <p style="margin:0;">
                    za pár dní se potkáme v Brně. A protože už zaschnul inkoust
                    na smlouvách, máme pro tebe celý program.
                    Odhalený. <strong>Jako tvoje máma.</strong>
                </p>
            </div>
        </td></tr>
        <tr><td style="height:20px; line-height:20px; font-size:0;">&nbsp;</td></tr>
        <tr><td style="background-color:#111111; border:1px solid #2A2A2A; border-radius:14px; padding:28px;">
            <div style="font-family:Arial Black, Arial, Helvetica, sans-serif; font-weight:900; font-size:20px; color:#F5F5F5; padding-bottom:18px;">
                Co tě čeká
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.5; color:#CCCCCC;">${rows}
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
                <tr><td style="border:2px solid #FE45E8; border-radius:999px;" align="center">
                    <a href="https://www.podrazdenacica.cz/cica-art-fest#program"
                       style="display:inline-block; padding:12px 26px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#FE45E8; text-decoration:none;">
                        Celý program s fotkami
                    </a>
                </td></tr>
            </table>
        </td></tr>
        <tr><td style="height:20px; line-height:20px; font-size:0;">&nbsp;</td></tr>
        <tr><td style="background-color:#111111; border:1px solid #FE45E8; border-radius:14px; padding:28px;">
            <div style="font-family:Arial Black, Arial, Helvetica, sans-serif; font-weight:900; font-size:20px; color:#F5F5F5; padding-bottom:12px;">
                Dražba už je venku
            </div>
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.6; color:#CCCCCC;">
                Deset děl, vyvolávací ceny zveřejněné, tichá dražba poběží přímo
                na festu do 20:00. Část výtěžku poputuje Lymfom Help, Nadaci
                Veronica a Opuštěným kočičím tlapkám. Vyhlídni si svůj kousek předem.
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;">
                <tr><td style="background-color:#FE45E8; border-radius:999px;" align="center">
                    <a href="https://www.podrazdenacica.cz/drazba"
                       style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold; color:#0D0D0D; text-decoration:none;">
                        Mrknout na katalog dražby
                    </a>
                </td></tr>
            </table>
        </td></tr>
        <tr><td style="height:20px; line-height:20px; font-size:0;">&nbsp;</td></tr>
        <tr><td style="background-color:#111111; border:1px solid #2A2A2A; border-radius:14px; padding:28px;">
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.6; color:#CCCCCC;">
                <strong style="color:#F5F5F5;">A jedna prosba na konec.</strong>
                Znáš někoho, kdo by na ČAF pasoval jak číča do krabice?
                Přepošli mu tenhle mail nebo hoď odkaz do skupiny. Tohle je
                první ročník a každá další hot číča, nezávislá fena i jejich
                obdivovatelé se počítají.
            </div>
        </td></tr>
        <tr><td style="padding:28px 8px 8px 8px;" align="center">
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:16px; line-height:1.6; color:#F5F5F5;">
                Tak v pátek. Přijď, nebo si to budeš vyčítat celej zbytek roku.
            </div>
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:16px; color:#FE45E8; padding-top:14px;">
                mňau ₍^. .^₎⟆<br>
                <span style="color:#F5F5F5;">Podrážděná číča</span>
            </div>
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:13px; color:#CCCCCC; padding-top:20px;">
                P. S. Fresh info a zákulisí sype
                <a href="https://www.instagram.com/cicaartfest/" style="color:#FE45E8;">@cicaartfest</a>
            </div>
        </td></tr>
        <tr><td style="padding:28px 8px 0 8px; border-top:1px solid #2A2A2A;" align="center">
            <div style="font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:1.6; color:#888888;">
                Tenhle mail ti přišel, protože máš vstupenku na Číča Art Fest.
            </div>
        </td></tr>
    </table>
</td></tr>
</table>
</body>
</html>`;

const TEXT = `Čaf číčo,

za pár dní se potkáme v Brně. V pátek 28. 8. od 15:30 v co.labs_parku (Kounicova 20) startuje první ročník Číča Art Festu. Program je odhalený. Jako tvoje máma.

CO TĚ ČEKÁ
${PROGRAM.map(([t, txt]) => `${t} ${txt}`).join('\n')}

Celý program s fotkami: https://www.podrazdenacica.cz/cica-art-fest#program

DRAŽBA UŽ JE VENKU
Deset děl, vyvolávací ceny zveřejněné, tichá dražba poběží přímo na festu do 20:00. Katalog: https://www.podrazdenacica.cz/drazba

Tak v pátek. Přijď, nebo si to budeš vyčítat celej zbytek roku.

mňau
Podrážděná číča`;

module.exports = { SUBJECT, HTML, TEXT };
