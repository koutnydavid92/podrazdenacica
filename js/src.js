// Odkud návštěva přišla: bez cookies, bez osobních dat. Při příchodu na web si
// stránka zapamatuje UTM parametry, značku prokliku z reklamy (gclid, fbclid),
// doménu odkazující stránky a první navštívenou stránku. Jen do sessionStorage
// (zmizí se zavřením panelu) a jen pro jedno použití: jde s objednávkou do
// obchodu (onanovanky.html -> api/checkout.js -> shop_orders.source), aby zdroj
// objednávky znal i u lidí, kteří nedali souhlas s cookies. Nikam dál se nic
// neposílá. Nový příchod z reklamy nebo s UTM předchozí záznam přepíše.
(function () {
    var KEY = 'pc_src';
    function host(u) {
        try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
    }
    function clean(v) { return String(v || '').trim().slice(0, 100); }
    function read() {
        try { var o = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
    }
    function write(o) { try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* bez úložiště jen pro tuhle stránku */ } }

    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = new URLSearchParams(''); }
    var utm = { s: clean(q.get('utm_source')), m: clean(q.get('utm_medium')), c: clean(q.get('utm_campaign')), n: clean(q.get('utm_content')) };
    var click = (q.has('gclid') || q.has('gbraid') || q.has('wbraid')) ? 'google'
        : q.has('fbclid') ? 'meta'
        : (q.has('sclid') || q.has('sznclid')) ? 'sklik' : '';
    var own = location.hostname.replace(/^www\./, '').toLowerCase();
    var ref = host(document.referrer);
    var external = (ref && ref !== own) ? ref : '';
    var touch = !!(utm.s || utm.m || utm.c || click);
    var stored = read();
    var current = { s: utm.s, m: utm.m, c: utm.c, n: utm.n, k: click, r: external, l: clean(location.pathname), t: Date.now() };

    if (touch || !stored) write(current);
    else if (!stored.s && !stored.k && !stored.r && external) {
        // Dřív uložený přímý příchod, teď známe odkazující stránku: doplnit
        stored.r = external;
        write(stored);
    }

    window.pcSource = function () {
        var o = read() || current;
        return { source: o.s || '', medium: o.m || '', campaign: o.c || '', content: o.n || '', click: o.k || '', referrer: o.r || '', landing: o.l || '' };
    };
})();
