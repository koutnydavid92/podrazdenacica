// Retargeting Skliku (Seznam). Sbírá publikum pro bannerový remarketing.
// Spouští se JEN po souhlasu s cookies (localStorage.cookieConsent === 'accepted'):
// hned při načtení, když je souhlas daný z dřívějška, jinak ve chvíli kliknutí
// na „Přijmout vše“ v cookie liště. Bez souhlasu se na Seznam nic neposílá.
// Retargeting ID je z rozhraní Skliku: Nástroje → Retargeting → Zobrazit kód.
(function () {
    var SKLIK_RTG_ID = 1714916; // účet Sklik koutnydavid92@gmail.com; 0 = vypnuto
    if (!SKLIK_RTG_ID) return;
    var sent = false;
    function hit() {
        if (sent) return;
        sent = true;
        var s = document.createElement('script');
        s.src = 'https://c.seznam.cz/js/rc.js';
        s.async = true;
        s.onload = function () {
            try {
                if (window.sznIVA && window.sznIVA.IS && typeof window.sznIVA.IS.updateIdentities === 'function') {
                    window.sznIVA.IS.updateIdentities({ eid: null });
                }
                if (window.rc && typeof window.rc.retargetingHit === 'function') {
                    window.rc.retargetingHit({ rtgId: SKLIK_RTG_ID, consent: 1 });
                }
            } catch (e) { /* měření nesmí nic rozbít */ }
        };
        document.head.appendChild(s);
    }
    try {
        if (localStorage.getItem('cookieConsent') === 'accepted') hit();
        var btn = document.getElementById('acceptCookies');
        if (btn) btn.addEventListener('click', hit);
    } catch (e) { /* ticho */ }
})();
