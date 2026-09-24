Valentin Plosz

Sun 20 Sept, 21:32 (4 days ago)

to me

# Versenytárs-kutatás és ötletlista — 2026. szeptember

Készült: 2026-09-20. Kutatási anyag, **nem spec** — semmi nem kötelez belőle, amíg kártya vagy `DECISIONS.md`-bejegyzés nem lesz belőle. A repóban ezen a fájlon kívül semmi nem változott.

Fő célpontok: **Outrank**, **BabyLoveGrowth** (BLG), **GetAutoSEO**. Mellettük a mezőny többi része (TheSEOAgent, RankYak, SEObot, Arvow, Soro, SiteLift, Shopify-appok).

---

## 0. A lényeg egy oldalon

**Amit a versenytársakról megtudtunk**

1. **A teljes körünket senki nem csinálja.** Search Console-adatból kiválasztott teendő (új cikk / optimalizálás / frissítés / javítás) + cikkenkénti, 28 napos ítélet sehol nincs. Részletek vannak: TheSEOAgent (publikálást blokkoló minőségi szűrő), RankYak (kannibalizáció-figyelés), Outrank (katalógus-szinkron + „Improvements").
2. **A „termékkatalógusra épülő cikk" a gyakorlatban egyiküknél sem működik.** Élő áruházi cikkek nyers HTML-je alapján: az Outrank egyik ügyfelénél tíz saját terméket felsoroló cikkben nulla terméklink; egy másiknál a Boston-szakasz a Calgary-plakátra mutat, a London-szakasz pedig egy _közvetlen versenytárs_ termékére. A BLG-nél 25 cikkben összesen 1 terméklink, két cikkben versenytárs termékoldalára mutató link. Ez a mi legnagyobb nyitott terepünk.
3. **Mindhárom fő versenytárs üzlete linkcserére épül**, és ez az ügyfél cikkeibe kerülő idegen, követhető (dofollow) linkeket jelent. A GetAutoSEO API-ja 422-vel visszadobja a szerkesztést, ha kiveszed a „védett" linket; az Outrank és a BLG fizetős linkpiacteret is üzemeltet. Élő példa: magyar otthonápolási cikk hongkongi cégre mutat; alvástermék-bolt cikkei fogorvosra, szemöldökszalonra, `schizophrenic.nyc`-re.
4. **A WordPress-pluginjaik gyengék és tanulságosak.** Outrank: minden telepítésben ugyanaz a beégetett titok, a token bármely posztot átírhat, slug alapú azonosítás, négy kiadás csak duplikátum-javítás. BLG: slug az egyetlen azonosító, idegen posztot felülír, kilenc hónapig plaintext kulcs és tárolt XSS. GetAutoSEO: a párosítás 2026-09-16-ig lényegében csak User-Agentet ellenőrzött; 85 kiadás 9 hónap alatt, szinte mind hibajavítás. A mi `publish_intents` modellünk ezeket a hibaosztályokat eleve kizárja.
5. **A kategória visszatérő panaszai** (Trustpilot, Shopify App Store): lemondás utáni terhelés és eldugott lemondás; generikus vagy _tényszerűen hibás_ szöveg; témán kívüli vagy káros backlinkek; megjelenés-visszaesés és nem indexelt tartalom tömeges publikálás után; értelmetlen AI-képek; „invalid token" telepítési hibák.
6. **Árhorgony: 99 USD / 30 cikk / hó.** GetAutoSEO 149 USD (Magyarországról 129 EUR, geo-árazott). Mindenki ad fizetés előtti belépőt (URL-ből terv + mintacikkek, 1 dolláros 3 napos próba, vízjeles cikk). Mi: 89 USD, próba nélkül.
7. **A GetAutoSEO alapítói magyarok** (Kertész Mihály, Zaborszky Péter; észt cég, a Shopify-app egy brit cég nevén fut). Fő esettanulmányuk magyar márka — magyar nyelvű oldaluk nincs.

**Amit a saját kódunkról megtudtunk közben** (ezek fontosabbak, mint bármelyik átvett ötlet — részletek a 4. fejezetben)

- **A publikált HTML nem a Markdownból készül.** A cikkíró Markdownt ad, a 3. kapu Markdown-linkeket ellenőriz, de a `htmlBody()` escape-eli a szöveget és szakaszonként egyetlen `<p>`-be teszi. A Shopifyra menő HTML-ben a belső linkek, táblázatok és bekezdések szó szerinti karakterként jelennének meg. Nincs rá kártya.
- **A perszóna hangneme, közönsége és nyelve nem jut el a cikkíróhoz** — csak az OPTIMIZE-ajánlás használja. A main §9.2 előírja.
- **Az „élő ár" nem élő:** árváltozás nem rendereli újra a publikált cikket.
- **A cikkek kép nélkül mennek ki**, a termékképeket a szinkron lekéri, majd eldobja.

**Javasolt sorrend** (9. fejezet): előbb a saját HTML-renderelés és a hangnem-átadás javítása, utána képek → szakaszonkénti terméklink-terv és ellenőrzés → JSON-LD. Az értékesítési oldalon: „nincs idegen link a cikkeidben", „lemondás egy kattintással", „legfeljebb napi 1, ha átmegy a szűrőn".

---

## 1. Módszer és korlátok

**Mit néztünk meg**

- Gyártói oldalak: főoldal, árazás, funkcióoldalak, dokumentáció, ÁSZF, sitemap, `robots.txt`, `llms.txt`.
- Nyilvános kód: a három WordPress-plugin teljes forrása, minden elérhető verzióval összevetve (BLG 25 tag, GetAutoSEO 85 tag, Outrank 1.0.0 és 1.0.10); az `outrank-cli` npm-csomag mind a hat verziója; az `outrank-next-js-blog` és a `babylovegrowth-next-js-blog` npm-csomag; a GetAutoSEO OpenAPI-leírása és árazási JSON-ja; MCP-szerverek metaadatai.
- Élő ügyfélcikkek nyers HTML-je (Shopify `.atom` feedek és blogoldalak): ripvan.com, routeprinter.com (Outrank), brass-steel.com, checkedoutwellness.com, mestric.com (BLG), aviancare.hu, growth-grid.ai (GetAutoSEO).
- Vélemények: Trustpilot, Shopify App Store, wordpress.org, Product Hunt.
- Saját repó: kód és spec sorról sorra a 15 ötlethez.

**Jelölések a szövegben:** **[KÓD]** = a forrásban olvastuk; **[OLDAL]** = lekért oldalon, HTTP-válaszban vagy nyers HTML-ben láttuk; **[KÖV]** = következtetés; **[HALLOMÁS]** = harmadik fél állítása, jellemzően affiliate-linkes blog.

**Korlátok**

- Letöltött kódot nem futtattunk, hitelesítést igénylő felületre nem léptünk be. A regisztráció utáni képernyőket egyik terméknél sem láttuk.
- A G2 403-at adott. Reddit-, YouTube- és Indie Hackers-tartalom alig került elő.
- A „független" tesztek többsége affiliate-linkes (BLG 25–35%, Outrank 30% élethosszig) — ezeket hallomásként kezeljük.
- Hogy egy adott ügyfélcikk az adott eszközzel készült, az lábnyomokból (képtárhely, fájlnév-minta, HTML-váz) levont következtetés.
- A kolléga által említett cikkek nem érkeztek meg, így azokból semmi nincs benne.
- A saját kódra vonatkozó állítások kódolvasásból származnak. Teszt, eval, éles Shopify-bolt nem futott — ahogy a `docs/handoff-next.md` szerint eddig soha.
- A Shopify App Store követelményeire vonatkozó rész (8.2) általános tudásból való, a jelenlegi Shopify-dokumentációval nem vetettük össze.

---

## 2. A mezőny áttekintése

| Szereplő               | Ár                                         | Belépő fizetés előtt                                      | Áruház-specifikus                                                        | Linkcsere                 | Ami egyedi                                           |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------- |
| **Outrank**            | 99 USD / 30 cikk; kiegészítők 1 899 USD-ig | vízjeles cikkek; 1 USD / 3 nap [HALLOMÁS]                 | Shopify-katalógus szinkron, témához illő termékek, első említés linkelve | igen + fizetős piactér    | GSC-alapú „Improvements", ügynök-API + CLI           |
| **BabyLoveGrowth**     | 99 / 399 EUR                               | 3 nap próba kártyával                                     | katalógus (Shopify-app, CSV/XML), termékenkénti kapcsoló                 | igen (kredites) + piactér | Reddit/Quora-ügynök, AI-láthatóság, ingyenes GSC-MCP |
| **GetAutoSEO**         | 149 USD (HU: 129 EUR); heti 29 EUR         | URL → 3 cikk + 30 napos terv kártya nélkül; 1 USD / 3 nap | Shopify-app olvassa a termékeket; dokumentált linklogika nincs           | igen, „védett" linkek     | infografika, `.md` URL, konverziókövető              |
| TheSEOAgent            | 99 USD / 30                                | 1 USD próba                                               | csak Shopify-blog                                                        | nem                       | publikálást blokkoló minőségi szűrő                  |
| RankYak                | 99 USD / 30                                | 3 nap                                                     | nincs                                                                    | igen                      | „Site Guard": GSC-kannibalizáció, MCP                |
| SEObot                 | 49 USD-tól                                 | visszatérítés az első cikk után                           | nincs                                                                    | nem                       | forráshivatkozás, pSEO                               |
| Arvow                  | 99–449 USD, kredites                       | nincs                                                     | nincs                                                                    | felső csomagban           | white-label, MCP                                     |
| Soro                   | 39 USD-tól                                 | 14 nap pénzvisszafizetés                                  | Shopify-plugin, katalógus nélkül                                         | nem                       | „100/100 pontszám"                                   |
| SiteLift               | 59–79 USD                                  | 7 nap                                                     | Shopify-integráció                                                       | „terjesztési hálózat"     | „90 napos növekedési garancia"                       |
| Bloggle (Shopify-app)  | 19,90–79,90 USD                            | 14 nap                                                    | **termékbeágyazás** a blogban                                            | nem                       | blogszerkesztő, nem robotpilóta                      |
| StoreSEO (Shopify-app) | 0–249,99 USD                               | ingyenes szint                                            | termék- és kollekció-meta, schema                                        | nem                       | `llms.txt`-generátor                                 |

Értékelések: Outrank Trustpilot 3,5 / 81 (30% egycsillagos), Shopify-app 3,6 / 8. GetAutoSEO Trustpilot 4,1 / 112, Shopify-app 2,3 / 3, nincs „Built for Shopify". BLG: a Trustpilot levette az értékelést ösztönzött vélemények miatt. Arvow 2,6 / 50.

---

## 3. A három fő versenytárs részletesen

### 3.1 Outrank (outrank.so)

**Üzlet.** „Grow Organic Traffic on Auto-Pilot." Korábban ContentPie; a váltás „tartalomról" „autonóm SEO-ra" hozta a növekedést. Bevétel: 60 ezer USD/hó 2025 júniusában, 83 ezer fölött 2026 januárjában [OLDAL: tmaker.io, Indie Hackers]; 300 ezer fölött 2026 áprilisában [HALLOMÁS]. Saját oldalukon ellentmondó ügyfélszámok („10 000+" és „1 200+"). Nincs AI-láthatóság-követő modul — a „10 000+ ChatGPT-említés" marketingszámláló. Nincs pénzvisszafizetési garancia. Megtartó erő a linkcsere: aki kilép, elveszíti a linkjeit.

**Saját növekedésük:** 28 kapu nélküli ingyenes eszköz; az audit eszköz _beilleszthető javító promptot_ ad ki; 100+ programmatikus `/playbooks/[szakma]` oldal; összehasonlító oldalak; 12 esettanulmány, ebből 6 Shopify; affiliate 30% élethosszig, 60 napos süti.

**Shopify.** „Blog Publisher" nevű ingyenes app (2025-12-29), tokenbemásolással — nem OAuth az Outrank felől. Jogosultságok a listázás szerint: termékek és kollekciók olvasása, Online Store oldalak és Fájlok szerkesztése, tulajdonosi személyes adatok. Az egyedi appos alternatíva `write_content`, `read_content`, `read_products`, `read_inventory` — egyszerre, nem külön engedélyként. Ígéret: lapozott katalógus-szinkron 10 ezer+ termékre, „smart retrieval", első említés linkelve, ár/készlet/SKU a katalógus-pillanatképből, életkép-fotók a termékképekből.

**Az egyetlen hosszabb használat utáni Shopify-vélemény** (Elise Beauty Supply, 3 hónap): „the blogs do not represent the product correctly… Remy hair extensions, but on the blog post were images of braiding hair… There is consistently no anchor texts linked to relevant products and collection pages." A négy ötcsillagosból három a telepítés utáni két napon belül íródott.

**Élő cikkek [OLDAL].**

- ripvan.com: tíz H2, mind egy-egy saját termékről; a törzsben **nulla** `/products/` vagy `/collections/` link; az egyetlen kereskedelmi link a záró CTA a főoldalra. Két kimenő link csere-elhelyezésnek látszik (jemeni kávéreceptek, borpárosítás), dofollow, önálló „You might also like…" mondatban [KÖV].
- routeprinter.com: hét versenyszakaszból két terméklink; a **Boston**-szakasz a Calgary félmaraton plakátjára mutat, holott létezik bostoni; a **London**-szakasz a versenytárs `printano.com/products/london` oldalára, dofollow, miközben van saját londoni plakátjuk.
- Lábnyomok: `cdnimg.co` képek, kebab-case H2 `id`-k, számozott lista → „… Comparison" táblázat → `<hr>` + főoldali CTA, `rel` nélküli külső linkek.

**Kód: `outrank-cli` 0.5.0 [KÓD].** ~80 soros fetch-burok az `/api/agent/v1` fölött; kb. 150 útvonalat fed fel (a doksi ~30-at). Náluk a „product" **webhelyet** jelent, nem katalógustételt — a Shopify-katalógus semmilyen nyilvános felületen nem érhető el.

- Minden válasz: `{ok, data, agent_guidance}` — hibánál is, a következő lépés szöveges leírásával.
- A beállítások önleírók: `_meta.fields.<mező>.{label, description, options, constraints}` + szerveren renderelt `_human` összefoglaló.
- A csomagban 50 KB-os `SKILL.md` ügynök-prompt utazik. Idézetek: „Treat product creation as blocked until you have … explicit human approval"; az improvements bekapcsolása „starts an unattended loop … Always tell the human this before enabling."
- Költés: árajánlat → megerősítés a visszaadott összeggel + `Idempotency-Key`.
- Integrációs igék: `validate` (nem mentett adatok), `test` (mentett sor), `prepare`, `connect` + lekérdezés `attempt_id`-vel.
- Hibák: a README szerint az `--api-key` a legerősebb, a kód szerint a környezeti változó (`config.js:52-55`); a webhook-doksi aláírást ígér, a CLI szerint nincs HMAC; három nap alatt törő átnevezés.

**Az „Improvements" modell [KÓD + OLDAL]** — a legjobb ötletük.

- Jelölttípusok: `outsider` (épp az első 5-ön kívül), `ctr_gap`, `declining`, `content_gap`, `thin_content`.
- Jelölt (szerkeszthető brief) → feladat (`scheduled_for`; cikkenként egy aktív, különben 409) → végrehajtás (`review_status`: `awaiting_review | pushed | auto_pushed | rejected`).
- A végrehajtás `before`, `after`, bekezdésszintű **hunkok azonosítóval**, `validation_issues`. Bírálat: `{"decisions":{"<hunkId>":"rejected"},"edited_hunks":{…}}`.
- `readiness = ready | not_connected | action_required | unsupported` — ki tud-e menni egyáltalán a módosítás.
- Először náluk mentődik, utána megy a CMS-be; külön `CMS_PUSH_FAILED`. Automatikus kiküldés letiltva „kemény validációs hibánál vagy ellenőrizetlen backlinknél".
- Eredmény kb. **két hét** után, a cikk saját bázisához mérve. A jel és a teendő 1:1-ben össze van kötve.
- **Kannibalizáció:** egyetlen paraméter nélküli GET, küszöbök és séma nélkül, a cikk létrehozásához semmi nem köti.

**Kód: WordPress-plugin 1.0.10 [KÓD].**

- Útvonalak: `POST /submit`, `PUT /edit`, `GET /posts`, `GET /capabilities`, `POST /test-integration`, `POST /set-integration-id`.
- `libs/api.php:5`: minden telepítésben azonos, beégetett `OUTRANK_API_SECRET`. A valódi hitelesítés a 64 karakteres token a törzsben — amit a `/posts` a `?secret=` query-paraméterben is elfogad.
- `/edit`: poszt WP-azonosító vagy `current_slug` alapján; **nincs tulajdon-ellenőrzés**, bármely poszt átírható vagy kukázható. A `/posts` piszkozatot és privát posztot is kiad teljes tartalommal.
- `/submit` nem idempotens; az 1.0.3, 1.0.7, 1.0.9, 1.0.10 mind slug-ütközés javítás. `wp_insert_post` hibája ellenőrizetlen (`api.php:875`). Képletöltés `sslverify=false`-szal, `svg` is engedett.
- Átvehető: `/capabilities` verziópróba; ritka PATCH (`array_key_exists` mezőnként); `warnings[]` a nem végzetes hibákra; képek helyi mentése forrás-URL szerinti deduplikálással; YouTube-only iframe-szűrő; adatot nem törlő eltávolítás.
- SEO-meta kulcsok (vakon, mind a négyet): `_yoast_wpseo_{metadesc,focuskw,title}`, `rank_math_{description,focus_keyword,title}`, `_aioseo_{description,keyphrases,title}`, `_seopress_titles_{desc,title}` + `_seopress_analysis_target_kw`.

**Hová megy az energiájuk:** 2026 májusa óta a fizetős backlink-piactérre (CLI 0.5.0, Stripe Connect), nem a katalógus minőségére.

### 3.2 BabyLoveGrowth (babylovegrowth.ai)

**Üzlet.** „Grow organic traffic from AI Search on autopilot." Teljesen horizontális (85 ügynökségi, 27 iparági programmatikus oldal, helyi szolgáltatók). Az AI-keresés a belépő üzenet, a Google a tényleges szállítás. Grow 99 EUR (30 cikk, 10 AI-prompt), Scale 399 EUR (120 cikk, 4 nyelv). Próba: 3 nap, kártyával, automatikus megújulás.

**Garancia és lemondás.** A kirakatban „90-day money-back guarantee"; az ÁSZF szerint nem jár, ha a kattintás, a megjelenés **vagy** a DR közül bármelyik nőtt — napi publikálás mellett a megjelenés szinte mindig nő. A docs GYIK közben: „we cannot offer refunds after the trial period ends". Lemondás: „at least 6 additional screens begging you to stay".

**Panaszok [OLDAL: Trustpilot].** „daily blogs are garbage"; „had to remove all of the articles… Full of formatting errors"; az üzletről „flat out wrong" állítások; „30 days later, still no backlink"; a linkek „harming more than benefiting"; a rendszer „picks the worse urls… from years ago"; „they don't refund".

**Funkciók, amik érdekesek.**

- Tartalomterv-naptár témánként nehézséggel és volumennel — **indoklás nincs**.
- Cikkbeállítások kapcsolóként: TL;DR, tartalomjegyzék, szerzői nézőpont, kapcsolódó cikkek, versenytárs-említés, JSON-LD, FAQ JSON-LD, hivatkozások régiója, záró jogi nyilatkozat, CTA-URL, márkahang max. 1000 karakterben, cikkenkénti kiemelt termék.
- „0–100 minőségi pontszám" — semmi nyoma, hogy bármit megállítana.
- Site Health: heti audit (`llms.txt`, JSON-LD, robots, sitemap, CWV…), semmit nem javít.
- Reddit/Quora-ügynök vázlat-kommentekkel, „Autopilot" móddal.
- **Ingyenes, fiók nélküli, csak olvasó MCP** (`seo:read`): GSC + GA4; 5–15. helyezés, kannibalizáció, hanyatló oldalak, AI-ajánlói forgalom. Ez lead magnet, nem publikáló felület.
- Saját gépezet: 2 885 blog-URL, 1 464 programmatikus oldal, ~40 ingyenes eszköz 7 nyelven, 161 összehasonlító oldal, **91 URL-es Shopify Akadémia**.

**Shopify.** Két külön, a kereskedő által létrehozott app: blog (`read_content`, `write_content`) és katalógus (`read_products`, `read_inventory`, kézi „Sync Catalog" gomb). Tárolt termékmezők: `id, title, description, link, image_link, price, currency_code, brand, product_type`. A katalógus csak linkforrás — tényellenőrzés nincs.

**Kód: WordPress-plugin 1.0.24 [KÓD].**

- `POST …/publish` (upsert) és egy **teljesen nyilvános** `GET …/ping` — ebből kívülről feltérképezhető az ügyfélkör (négy esettanulmány-domainen 200-at adott).
- **A slug az egyetlen azonosító** (`get_page_by_path`). A payload `id`, `jsonLd`, `faqJsonLd`, `createdAt` mezőit a plugin nem olvassa. Következmény: azonos slugú emberi posztot némán felülír; slug-szerkesztés után duplikál; minden újraküldés visszaállítja a státuszt, kategóriát, címkét; a kézi szerkesztés elvész.
- Nincs törlés, ütemezés, cikkenkénti taxonómia; WooCommerce-kód egyáltalán nincs.
- A push csak Bearer-tokent visz: nincs HMAC, időbélyeg, kézbesítési azonosító. Újrapróbálás 3×, 2 mp-enként, csak 429/5xx-re; időtúllépésre soha.
- Ami jó: `blg_` előtagú kulcs SHA-256-tal tárolva, átvételi ablakkal; a helyes kulcs ellenőrzése a fojtás **előtt** (frissen forgatott kulcs nem zárható ki); a titok két fejlécben (a tárhelyek lecsupaszítják az `Authorization`-t); `ignore_user_abort` + borítókép először + háttér-újrapróba; képbetöltés forrás-URL dedupe-pal, leghosszabb URL először; JSON-LD adatként tárolva és kiíráskor újrakódolva; IP-mentes tevékenységnapló; a válaszban `full_html: on|off|unavailable` képességjelentés.
- A KSES-lazítás (iframe, `div[style]`) **az egész webhelyre és minden szerzőre** érvényes. Az 1.0.24 „unfiltered HTML" kapcsolójával a kulcs admin-szintű szkriptbeszúrást jelent.
- **A changelog hibanapló:** a WPML-támogatás törölte a poszttartalmat (javítás 93 perc múlva); a tárhelyek levágták az `Authorization` fejlécet; a REST-en létrehozott posztok nem kerültek a sitemapbe; tíz hónapig hotlinkelt képek; kilenc hónapig plaintext kulcs, valódi `permission_callback` nélkül, nyersen kiírt JSON-LD (tárolt XSS) — 2026 augusztusában javítva.
- Egy év alatt semmi WooCommerce, cikkenkénti taxonómia, ütemezés, törlés vagy eltérés-észlelés irányába.

**Élő cikkek [OLDAL].**

- Állandó váz: üres `<p>` → válasz-bekezdés → TL;DR idézetblokk → tartalomjegyzék → 6–8 kérdés formájú H2 → „Pro Tip" → **kitalált egyes szám első személyű alapítói szakasz a tulajdonos nevével aláírva** („— Davide") → CTA → Sources → FAQ → Recommended. ~2 200–2 400 szó.
- Hivatkozások `rel="nofollow noopener noreferrer"`; a csere-linkek csak `rel="noopener"`, tehát dofollow, a törzsszövegbe szőve [KÖV]. checkedoutwellness.com: 30 posztban 15, egy részük teljesen témán kívüli. A súgó azt tanácsolja, kapcsold ki a Rank Math „nofollow external links" beállítását.
- Termékkötés: brass-steel.com 25 posztban 173 bloglink, 5 `/collections/all`, **1 terméklink**; két poszt versenytárs termékoldalára mutat. Sehol nincs termékkártya, ár, készlet, Product schema.
- Képek Shopifyon a BLG Supabase-tárhelyéről hotlinkelve — ha az megváltozik, minden ügyfél blogképe eltörik.
- Élő hibák: YouTube-beágyazás `<img src="https://www.youtube.com/watch?v=…">`-ként; `node="[object Object]"` attribútum; árva bekezdés a „Sources" alatt; katalóguson kívüli témák (öntöttvas-tanácsok csak szénacélt áruló boltnak).
- Schema: `FAQPage` sehol, pedig az API-ban van `faqJsonLd`. A WordPress-ügyfelek jelenleg **semmilyen** BLG-schemát nem kapnak [KÖV: a beágyazott ld+json kikerült a HTML-ből, a plugin pedig nem olvassa a strukturált mezőt].

### 3.3 GetAutoSEO (getautoseo.com)

**Üzlet.** „Get Found & Recommended by ChatGPT, Perplexity AND Google." Célcsoport: nem technikai kisvállalkozók; az ár egy havi 5 000 USD-s ügynökséghez van horgonyozva. Automated SEO OÜ (Tallinn); a Shopify-app ZII Ltd (UK) néven. Nincs AI-láthatóság-követés (külön testvértermék: trackmybusiness.ai), nincs saját `llms.txt`.

**Onboarding — a legjobb konverziós mechanikájuk.** Egyetlen mező (URL), „Get 3 Articles + 30-Day Content Plan", „Takes 4 minutes · No credit card needed". PostHog A/B-teszt naptár-első landinggel. A főoldalba három teljes mintacikk van ágyazva (2 837–2 986 szó, kulcsszóval, borítóképpel, infografikával).

**Árazás.** Egy csomag, egy webhely. Geo-lokalizált; rejtett heti csomag (29 EUR); sürgető sor: „Price increases to €195 for new customers soon." Visszatérítés: 7 nap havi, 30 nap éves. Ígéret: „If we don't write 30 articles… next month free." A Shopify-oldalon forrás nélküli, kitaláltnak látszó @-idézetek.

**Panaszok [OLDAL].** „Despite cancelling… charged for another month"; „feels designed to make cancelling as annoying as possible"; „outbound links to unrelated third-party businesses… including… a direct competitor"; „thin… Google… will not index them"; „destroyed my #1 seo positions"; „not suitable for Food… got it wrong 5 times".

**Kód: WordPress-plugin 1.3.110, ~11 ezer sor [KÓD].**

- **Párosítás.** A plugin hitelesítés nélkül elküldi a `site_url`-t és egy telepítési tokent; a SaaS visszahív a webhely `/handshake` útvonalára, majd kiadja az API-kulcsot. A tulajdonjog bizonyítéka ennyi: „ezen az URL-en fut a pluginunk, és az URL szerepel egy fiókban". A telepítési token ellenőrzése **az 1.3.110-ben (2026-09-16) jelent meg**; addig a visszahívás bármely megfelelő User-Agentű kérésre válaszolt, és a régi verziók a kulcsot tartalmazó választ a hibanaplóba írták, alapból bekapcsolt debuggal. Ügyféloldalon ma is fut 1.3.86.
- **Szinkron: pull és push is.** `GET /api/articles/sync?since=` (adaptív cron: percenként → 5 percenként → óránként) és `POST /trigger-sync` legfeljebb 50 cikkel, képek külön `POST /push-image`-dzsel. HMAC-aláírás a törzsre, de időbélyeg és nonce nélkül (visszajátszható). Zárolás DB-sorral, atomi `UPDATE … WHERE status='pending'` — ugyanaz, mint a mi őrzött átmenetünk, csak tíz kiadás alatt jutottak el odáig.
- **Létrehozás vagy frissítés:** négy ellenőrzés sorban — szinkrontábla → `_autoseo_article_id` meta → `previous_article_ids[]` bármelyik őse → **pontos címegyezés**. Az utolsó némán magáévá tesz bármely azonos című idegen posztot.
- **A „lemondás után is publikált" panasz magyarázata.** A pluginban nincs helyi jogosultság-ellenőrzés — a számlázási állapotot kizárólag a szerver érvényesíti. A push mód és a **törölt poszt kétszeri automatikus újralétrehozása** (`recreate_count`) lehetővé teszi, hogy a szerver a helyi crontól függetlenül publikáljon és felélesszen. Egy szerverhiba vagy bennmaradt kulcs = további posztok.
- **Szerkesztőzár.** Az AutoSEO-posztokon kikapcsolja a Gutenberget, elrejti a „Kukába" gombot, blokkolja a végleges törlést. Valódi kézi szerkesztésnél viszont beállít egy `_autoseo_manual_content_override` jelzőt, és onnantól csak címet és metát frissít — **ez jó minta**.
- **Oldalépítő-védelem.** Első publikáláskor _törli_ az Elementor/Divi/WPBakery/… metát; ha később oldalépítővel szerkesztik, csak címet/metát frissít.
- **ACF/téma-tartalék.** Ha a téma nem a `the_content()`-et rendereli, a plugin ACF-mezőkbe másol, végső esetben kimeneti pufferrel injektál — ebből lettek az üres oldalas és HTTP 500-as regressziók (1.3.104–106).
- **SEO-meta:** natív mezők Yoast, Rank Math, SEOPress, **AIOSEO (a saját `aioseo_posts` táblájába)**, SmartCrawl; ha egyik sincs, saját `wp_head` meta + OG/Twitter. **FAQPage JSON-LD mindig megy.**
- **`.md` végpont:** bármely AutoSEO-cikk URL-je + `.md` → `text/markdown`.
- **Konverziókövető:** `gtag`/`dataLayer`/`fbq` köré csomagol, vásárlás/lead eseményeket küld `visitor_id`-vel és 30 napos cikk-attribúcióval. **Süti-hozzájárulás nélkül.**
- Többnyelvűség: teljes WPML + Polylang, fordítások összekapcsolásával. WooCommerce-adatot **nem olvas**. Eltávolítás tiszta.

**Cikk-adatmodell [KÓD].** `id, title, slug, content, content_markdown, excerpt, keywords[], meta_description, wordpress_tags, hero_image_url, hero_image_alt, infographic_html, infographic_image_url, faq_schema[{question,answer}], language, source_article_id, previous_article_ids[], published_at, updated_at, status` + `auto_publish, needs_url_confirmation, force_content_update`. Nincs szerző, kategória, canonical, Article JSON-LD.

**Nyilvános API [OLDAL].** 7 útvonal; 60 kérés/perc, 200 szerkesztés/nap. A lényeg a **`ProtectedLink{type: backlink|internal, href, text}`**: a védett linket eltávolító `PUT` 422-t kap, a válasz visszaadja a megtartandó linkeket. Szó szerint: „An edit that strips them is rejected so the backlink network stays intact." A marketing „checked by hand"-et állít; az alapító a LinkedInen: „link building between clients – zero human operators".

**Élő cikkek [OLDAL].** Váz: H1 → bevezető → `key-takeaways` doboz → tartalomjegyzék horgonyokkal → 4–6 H2 → infografika (`getautoseo.com/storage/…`-ról) → puha CTA → GYIK 6–8 kérdéssel + FAQPage JSON-LD. 2 800–3 500 szó. Cikkenként **egy-két ügyfelek közötti backlink**, `nofollow`/`sponsored` nélkül: az AVIAN Care (magyar otthonápolás) cikke a `fivestep.com.hk`-ra mutat. **Webflow-n a cikktörzs HTML-entitásként érkezik, és kliensoldali `innerHTML` illeszti be** — a szerver HTML-jében nincs benne, ami éppen a keresőknek és AI-robotoknak rossz.

### 3.4 A mezőny többi része

_(Az üzleti áttekintés alapján; a kódszintű kiegészítés — TheSEOAgent szűrő, RankYak Site Guard, SEObot SDK, Shopify-appok beágyazási megoldása — a 3.5-ben.)_

- **TheSEOAgent** — az egyetlen másik, publikálást blokkoló szűrő: „The post publishes only after the quality score is high enough"; a bukott piszkozat „return[s] for another pass instead of being dispatched to Shopify"; blokkol ellenőrizetlen állításnál, hiányzó belső linknél, hiányzó képnél/metánál. A küszöb nem nyilvános. A cikkek „arrive as drafts while the store is still calibrating voice". „Cancel in app"-ot hirdet. Katalógust nem olvas, GSC-t nem említ.
- **RankYak** — „Site Guard": napi cím- és CTR-figyelés, GSC-alapú kannibalizáció-észlelés **átirányítási javaslattal**. A legközelebbi rokona a mi meglévő-célpont ellenőrzésünknek, de utólagos és átirányít — mi szándékosan nem.
- **SEObot** — „enter your url and press go"; akár 4 000 szavas cikkek forráshivatkozással; jóváhagyás/elutasítás; visszatérítés, ha az első cikk után elégedetlen vagy.
- **Arvow** — kredites árazás (15 kredit/cikk), felső csomagban backlink, LLM-követő, white-label. Trustpilot 2,6: lemondás utáni terhelés, „Backlinks … completely unrelated to my niche", „Glorified ChatGPT wrapper".
- **SiteLift** — „90-day growth guarantee" (feltételeit nem néztük meg), 20 összehasonlító oldal építése.
- **Bloggle** — blogszerkesztő **termékbeágyazással**. Egycsillagosok: importnál szétesett elrendezés, lassabb oldalak, eltávolítás utáni terhelés.
- **Auto Blogs Agent** — ingyenes szint 3 bloggal. Panasz: „completely illogical images".
- **StoreSEO** — on-page csomag `llms.txt`-generátorral. Egycsillagos: a saját pontszámát rontó AI-metaleírások.
- **AI-láthatóság-követők** (Peec, Profound, Otterly) — csak riport, márkaszinten, áruházadat nélkül.

### 3.5 A mezőny többi részének nyilvános kódja

**TheSEOAgent — hogyan működik valójában a „minőségi kapu" [OLDAL].**

- Egyetlen 0–100-as `quality_score` (az API-ban is látszik, mellette egy nullázható `ai_score`). A dimenziók neve oldalról oldalra más: „accuracy, originality, link strategy, structure", máshol „research support, structure, usefulness", megint máshol „reading level, keyword density". **A küszöb sehol nincs közzétéve.** A marketing szerint egy blogposzt „lists every item the gate applies" — a poszt általános SEO-ellenőrzőlista, kapurubrika nélkül.
- Tényellenőrzés négy lépésben: író → külön ellenőrző modell kigyűjti az ellenőrizhető állításokat → mindegyik friss webkeresésen fut át → az igazolt hivatkozást kap, az igazolatlant átírják. Az egyetlen kemény szám: ha az állítások kb. **30%-a** megbukik, a cikk „is not redeemable … goes back to the writer". A „fact-check against live SERPs" tehát állításonkénti webkeresés, nem SERP-összevetés.
- **Bukásnál újragenerál, felső korlát nélkül** („no surcharge for regenerations") — nem szünetel. A „draft while calibrating" egyetlen mondat: ugyanaz a publikál/piszkozat kapcsoló, kalibrációs mechanizmus nélkül.
- **Összevetés:** egyetlen átlagolt pontszám, dimenziónkénti alsó határ nélkül. A mi szabályunk (minimumra kapuzunk, egy javítókör, külön vak bíró, szünet a lebutítás helyett — 11. és 22. inv.) kimutathatóan szigorúbb, és ez leírható.
- API-higiénia, ami átvehető: `Idempotency-Key` fejléc, eltérő törzsnél 409 `idempotency_key_reused`; `request_id` minden válaszon; webhook-aláírás `t=…,v1=HMAC-SHA256("${t}.${rawBody}")` 5 perces visszajátszási ablakkal, `event_id` szerinti deduplikálás; feladatonkénti `cost_usd`. Náluk is van napi 1 cikk/projekt limit (`429 daily_limit_reached`).
- WordPress-plugin (507 sor, <10 telepítés) [KÓD]: saját meta (`_seobot_external_id`) az azonosító — jó; de **a frissítés létrehozásra esik vissza, ha a poszt eltűnt** (`action: recreated`), és frissítéskor a `post_status`-t is visszaírja, vagyis a kereskedő által visszavont poszt újra élesedik. Pontosan az, amit a 19. invariánsunk tilt. Schemát a plugin nem injektál, a „FAQ schema, article schema" ígéret ellenére. Shopify: App Store-beli appot állítanak, listázást nem találtunk; a számlázás Stripe-on marad.

**RankYak — „Site Guard" [OLDAL].** Havi 99 USD-s kiegészítő, GSC kell hozzá.

- _Cannibalization Guard_, éjszakánként, két forrásból: (1) „keyword clusters holding more than one published article, which compete by construction"; (2) „sets of pages splitting impressions on the same searches in your Search Console data, whether RankYak wrote them or not". Megerősítés SERP-átfedéssel: minden oldal legerősebb keresésére megnézi, mit ad vissza a Google.
- Kimenet kétfelé: **összevonási terv** (javasolt győztes + kész 301-lista) és **figyelőlista** („merging them would trade two rankings for one"). Győztes-szabály: „the page that earns real clicks and, when clicks are too few to judge by, the page Google already shows most; **the entry states which of these signals decided**." A veszteseket archiválja (élnek, de kimaradnak az optimalizálásból és belső linkelésből). Magától lezárul, ha az átfedés megszűnik; az elvetett bejegyzés nem tér vissza. Számszerű küszöb nincs közzétéve.
- _Page Guard_: a CTR „well short" az átlagpozícióhoz várthoz képest; cím ~30–60, leírás ~70–155 karakteren kívül (a márka-előtagot leszámítja).
- _Frissítés_: webhelyenként napi egy művelet (írás **vagy** optimalizálás); a jelölt az az oldal, „that has lost the most clicks against the period before it". A frissítés felülírja a kézi szerkesztést (korábbi változat revízióként megmarad).
- **Összevetés:** publikálás **után** fut, fizetős takarításként. Publikálás előtti meglévő-célpont ellenőrzést senki nem dokumentál — a mi 6. invariánsunk ebben egyedül áll. Átvenni érdemes: az összevonás–figyelés kettéválasztást és a _döntő jel megnevezését_ (nálunk ez sablonból jön, 8. inv.).
- WordPress-plugin [KÓD]: nem fogadó — **WordPress alkalmazásjelszót generál az aktuális felhasználónak, és elküldi a gyártónak** a felhasználónévvel együtt; onnantól a core `wp/v2` REST-et használják Basic auth-tal. A menü `edit_posts` jogosultsággal nyílik, tehát egy Közreműködő is ráköthetné a webhelyet bármely RankYak-fiókra. Deaktiváláskor a jelszó él tovább. A gyártó teljes jogú hitelesítő adatot tart, nem szűkített tokent. Shopify: a kereskedő által létrehozott egyedi app, nincs az App Store-ban.

**SEObot [KÓD].** Pull-architektúra statikus S3 JSON-ból; **az API-kulcs az URL útvonalszegmense**, a forrásban nyilvános demókulccsal. A cikkmodellben nincs nyelv, schema, GYIK, szerző. A cikk `html`-je harmadik féltől származó `<script>`-et ágyaz az ügyfél tartalmába (banner). A SEObot az igazság forrása: a CMS-ben szerkesztett tartalmat a szinkron felülírja. Lemondás után a cikkek és a fel nem használt kreditek megmaradnak.

**Arvow [KÓD].** WordPress-plugin: `permission_callback => '__return_true'`, a titok a törzsben vagy fejlécben; **párosításkor a titok GET query-ben utazik**; csak létrehozás, külső azonosító nélkül — minden újraküldés duplikál; a `post_type` validálatlanul jön a kérésből. Az 1.5.4 changelogja: „Fixed an authentication bypass when the integration secret was not configured". Ami jó: a legteljesebb SEO-meta lefedés, `is_plugin_active`-hoz kötve (Yoast, AIOSEO, Rank Math, SEOPress, The SEO Framework, Squirrly, OG/Twitter mezőkkel). API: `POST /internal-links` a cikkszöveget a sitemap URL-enkénti embeddingjeihez méri, válasz `{anchor, index, length, urls[]}` — tiszta, tesztelhető szerződés. „Site Optimizer": JS-snippet, ami kliensoldalon írja át a címet, leírást, canonicalt — a CMS-ben láthatatlan.

**Soro [KÓD] — a legjobban megírt fogadó (10 000 telepítés nyolc hónap alatt).** Idempotens a `_soro_article_id`-n: ismétlésre a meglévő posztot adja vissza `duplicate: true`-val, és soha nem frissít. **Slug-ütközésnél piszkozatként hozza létre** („so Soro stops retrying … to avoid SEO cannibalization"). A SEO-metát a `wp_insert_post` `meta_input`-jában írja, hogy a Yoast/Rank Math/AIOSEO `save_post` hookjai lássák, majd újraépíti a Yoast indexable-t — a changelog szerint ez valódi hibát javított. A borítókép hibáját lenyeli, hogy a válasz `post_id`-t vigyen, és a szerver ne próbálkozzon duplikátumba. Gyengéi: egy 999-es prioritású szűrővel feloldja a `soro/v1/*`-t a REST-et lezáró oldalakon (más plugin biztonsági döntését írja felül); eltávolításkor semmit nem takarít; IndexNow-kulcsfájlt ír a web gyökerébe.

- **Shopify-appja** (39 USD, Shopify-számlázás, 4,4 / 20): **termék-scope egyáltalán nincs.** A vélemények pontosan azt sorolják, amit mi tudunk: nincs terméklink („I add every product link manually"); a SEO-cím az H1 másolata; azonos sablonblokkok cikkről cikkre; **„numbers are inconsistent across articles on the same topic … keep a single source of truth for facts"**; „Admin" szerző, üres kép-altok, nincs GYIK.

**Shopify-natív appok [OLDAL + KÓD].**

- **Bloggle:** a termékbeágyazás üres váz a `body_html`-ben (`<img src="" alt="">`, üres cím), amit a cikktörzsből betöltött CloudFront-szkript tölt ki a `/products/<handle>.js`-ből. **A keresőrobot csupasz linket lát** terméknév, kép és ár nélkül. Metafield, app block, theme app extension nincs. A JSON-LD a témától jön, nem a Bloggle-tól.
- **Auto Blogs Agent** (Built for Shopify, 4,7 / 119): `BlogPosting` + `FAQPage` JSON-LD **a cikktörzsbe injektálva** — a téma már ad saját `Article`-t, így oldalanként két versengő cikk-entitás van. Minden cikken „About the Author" kártya **kitalált személlyel** („Emily Walker … over seven years of experience"), a képek `alt=""`.
- **StoreSEO:** a legszélesebb scope-készlet, amit láttunk (vásárlók, termékek, téma, app proxy, fájlok, navigáció…). Az `llms.txt`-generátora **mára nagyrészt okafogyott**: élő boltokon (allbirds.com, a Bloggle demóbolt) a `/llms.txt`-t **maga a Shopify szolgálja ki** `text/markdown`-ként. **Shopifyra ne építsünk `llms.txt`-funkciót.**
- **Terjesztés:** öt riválisból három (RankYak, SEObot, Arvow) megkerüli az App Store-t a kereskedő által létrehozott egyedi appal (`write_content`) és Stripe-számlázással. Shopify-számlázást csak a Soro és az Auto Blogs Agent használ, és csak az utóbbi „Built for Shopify".

**Nyílt forráskód, amiből számok vehetők** (a mi küszöbeink a `packages/rules`-ban élnek — 9. inv. —, ezek csak kiindulópontok):

- `iannuttall/seo` (525★, Apache-2.0), `cannibal-analysis.ts`: márkalekérdezések kizárása; `MINIMUM_PAGE_IMPRESSIONS = 10`, `MINIMUM_PAGE_SHARE = 0.1`, `MAXIMUM_DOMINANT_SHARE = 0.8`; URL-enkénti oldalsablon-észlelés; 100 ezer soros csonkítás-jelző; és olyan ítéletsztringek, amelyek **részleges adaton nem adnak „minden rendben"-t** („partial evidence prevents an all-clear").
- `saurabhsharma2u/search-console-mcp` (292★): lekérdezés × oldal sorok, megjelenés ≥ 50 és pozíció ≤ 20; konfliktuspontszám `1 − HHI` a kattintási részesedésekre; jelez, ha > 0,1 vagy a második oldal megjelenése a vezető 20%-a fölött; rangsor `összkattintás × konfliktus`.
- Egy névrokon WordPress-plugin (`seobot-ai`, nem a seobotai.com) kétlépcsős duplikátum-észlelője: `similar_text` a címekre ≥ 60%, majd embedding-koszinusz ≥ 0,85.

**A többi szereplő csatlakozói egy táblában**

| Szereplő       | Irány                    | Párosítás                                     | Egyezési kulcs                          | Frissítés                                                              | Leválasztás                                   |
| -------------- | ------------------------ | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| TheSEOAgent WP | push, saját REST-útvonal | bemásolt 64 karakteres token                  | meta `_seobot_external_id`              | helyben frissít; **ha hiányzik, újra létrehozza**; státuszt visszaírja | token törlése; nincs takarítás                |
| RankYak WP     | push a core `wp/v2`-n    | a plugin alkalmazásjelszót generál és elküldi | WP poszt-azonosító szerveroldalon [KÖV] | újrapublikál; felülírja a kézi szerkesztést                            | távoli DELETE; a jelszó túléli a deaktiválást |
| Arvow WP       | push, saját útvonal      | közös titok; a titok az átirányítási URL-ben  | **nincs**                               | **csak létrehoz**                                                      | a titkot törli                                |
| Soro WP        | push, saját útvonal      | generált kulcs fejlécben                      | meta `_soro_article_id`                 | **soha nem frissít**; a meglévőt adja vissza                           | semmit nem takarít                            |
| SEObot         | **pull** (CDN JSON)      | kulcs az URL-ben                              | `id` / slug                             | a gyártó az igazság forrása                                            | a tartalom olvasható marad                    |

Senki nem szállít schemát strukturált mezőként, és senki nem szállít termékhivatkozást az adatmodellben.

---

## 4. Amit a saját kódunkban találtunk

Ezek nem versenytárs-ötletek, hanem a 6. fejezet több ötletének **előfeltételei**. Mind kódolvasásból származik; éles bolton semmi nem futott.

### 4.1 A publikált HTML nem a Markdownból készül (A lelet)

- A 3. kapu Markdown-linkeket (`packages/core/src/gates/gate3/lints.ts:84-91`: `\[…\]\((…)\)`), Markdown-táblázatokat (`gates/gate3/structure.ts:88`) és kódblokkokat ellenőriz.
- A `htmlBody()` (`packages/core/src/publish/bundle.ts:168-185`) viszont ezt teszi: `escapeHtml(stripClaimMarkers(text))`, majd az egész szakasztörzset **egyetlen `<p>`**-be csomagolja. A `tidy()` csak szóközöket igazít.
- Egyik `package.json`-ban sincs Markdown-könyvtár.
- Ez a HTML megy a Shopifyra (`packages/jobs/src/publish/auto-publish.ts:214`) és a cikkoldalra (`packages/ui/src/content/ArticleDetail.tsx:198`). Csak a `{{pN}}` tokenekből lesz `<a>` (`publish/resolve.ts:150-156`).
- A `bundle.test.ts` csak a token-linket teszteli, Markdown-linket vagy táblázatot a HTML-ben soha.
- **Következmény a kód szerint:** a belső linkek, összehasonlító és mérettáblázatok, lépéslisták és a bekezdéstörések szó szerinti karakterként érkeznének a boltba. A Markdown-export (`markdownBody`) ettől függetlenül rendben van.
- Kártya és `DECISIONS`-bejegyzés nincs rá. **Első lépésként ezt kell ellenőrizni** (egy fixture-cikk HTML-jének megnézésével), és ha igaz, javítani. D sáv, S–M, migráció nélkül.
- Tanulság a versenytársaktól: a BLG élő hibái (YouTube `<img>`-ként, szivárgó attribútumok) pontosan ilyen renderelési rések. Érdemes **csatlakozónkénti HTML-szerződéstesztet** írni.

### 4.2 A hangnem nem jut el a cikkíróhoz

- `buildDraftRequest` (`packages/core/src/generation/draft.ts:143-172`) kulcsszót, formát, szakaszsorrendet, hosszt, linkeket, állításokat és terméknevet küld — hangnemet, közönséget, nyelvet **nem**. A fájlban a `tone`, `language`, `audience` szavak nem szerepelnek.
- A hangnem egyetlen fogyasztója az OPTIMIZE: `packages/core/src/optimize/recommendation.ts:263`.
- main §9.2: „in the persona's language and tone (§6.5)".
- A profil megerősítés után nem szerkeszthető (`profile_already_confirmed`), ami ellentmond a main §6.8-nak: „Every section remains editable later from settings".
- Ez spec-megfelelés, nem alapítói döntés. D sáv, `draft.v3`, S — de `pnpm eval` kell hozzá, ami még sosem futott.

### 4.3 Az „élő ár" nem élő (B lelet)

- A `{{p1}}` tokenek feloldása a **mi `products` táblánkból** történik a csomag összeállításakor, nem Shopify-hívásból.
- `packages/core/src/repair/drift.ts:103-116`: a `price_changed` semmire nem képződik le; a komment szerint „the value in the body re-renders on the next hand-over". A crontabban nincs újrarenderelő feladat.
- Az automatikusan publikált poszt ár- és készletszövege tehát befagy, amíg más javítás vagy frissítés újra nem publikálja. A 2026-09-01-i alapítói döntés („one external write per re-render") ezt tudatosan fogadta el — de egy **látható termékkártya** a befagyott árat szembetűnővé tenné.

### 4.4 Képek

- A szinkron lekéri (`PRODUCT_FIELDS` tartalmazza az `images`-t: `packages/jobs/src/ingestion/catalog.ts:73-74`, `sweep.ts:71-72`), a checksumba beleszámolja, majd eldobja — a `toProductRow` nem viszi tovább, a `products` táblának nincs képoszlopa.
- Az evidence pack típusában van `images`, de mindig `[]` (`packages/jobs/src/generation/assemble-evidence-pack.ts:89`; ugyanígy `packages/jobs/src/publish/bundle.ts:169`). A `catalogImagesFor` (`generation/images.ts:28`) csak a saját tesztjéből hívódik.
- A Shopify-payloadban (`packages/providers/src/shopify/publish.ts:411-428`) nincs `image`, szerző, SEO-metafield.
- Alapítói döntés, DECISIONS 2026-09-04: „Auto-published articles ship without images, for now… a known departure to revisit." T5.1: „PARKED, needs a schema wave".

### 4.5 Apróbb leletek

- A GYIK címsora (`<h2>FAQ</h2>`) és a készlet/akció szövegek (`'in stock'`, `'on sale'`… `publish/resolve.ts:95-103`) **beégetett angol** — a bolt nyelvén írt cikkbe is. Magyar piacon ez azonnal látszana.
- A `resolveProductReferences` **minden** előfordulást linkké tesz, nem csak az elsőt.
- A main §9.2 szerint „every article links the referenced product/collection pages" — a kollekciólinket semmi nem kényszeríti ki.
- Az evidence packbe a témához rendelt családok **minden** tényadatlapos terméke bekerül `products.id` sorrendben, státusz-, elérhetőség- vagy relevanciaszűrés nélkül (`packages/db/src/repositories/distill.ts:132-164`).
- A `landing_revenue_daily` töltődik, de semmi nem olvassa (szándékosan: main §17.3).
- A `docs/content-spec.md` **más kódbázist ír le** (`docs/content-pointers.md` 3–7. sor) — ne tervezzünk belőle.

---

## 5. Összehasonlító táblák

### 5.1 WordPress-csatlakozók felépítése

|                      | Outrank                                                  | BabyLoveGrowth                                   | GetAutoSEO                                          | Javasolt Sortiva                                                                                                    |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Irány                | push                                                     | push                                             | pull (cron) + push                                  | push a `publish_intents`-en át; pull tartalékként tűzfal mögötti oldalakra                                          |
| Párosítás            | 64 karakteres token bemásolva                            | pluginban generált `blg_` kulcs, hash-elve       | „kulcs nélküli" visszahívás; tulajdont nem bizonyít | aláírt kihívás szerveren kiadott egyszeri tokennel **és** a WP-ben generált titokkal                                |
| Kérés hitelesítése   | token a törzsben (query-ben is!) + beégetett közös titok | Bearer + `X-API-Key`; aláírás nincs              | kulcs + HMAC, időbélyeg nélkül                      | csak fejlécben; HMAC időbélyeggel + kézbesítési azonosítóval                                                        |
| Poszt azonosítása    | WP-azonosító vagy slug                                   | **csak slug**                                    | saját meta → ősök → **címegyezés**                  | **csak saját meta** (`_sortiva_article_id`) + tartalomhash; slug-ütközés idegen poszttal = 409                      |
| Idegen poszt védelme | nincs                                                    | nincs                                            | címegyezésnél nincs                                 | csak saját posztot szerkesztünk                                                                                     |
| Kézi szerkesztés     | felülírja                                                | felülírja                                        | `_manual_content_override` → csak meta frissül      | hash-eltérésnél szünet és jelzés (22. invariáns)                                                                    |
| Törlés               | `/edit` státusz `trash`                                  | nincs                                            | szerver kukáztat; törölt posztot 2× újra létrehoz   | törlés és visszaolvasás az első naptól; soha nem élesztünk fel törölt posztot                                       |
| Képességpróba        | `GET /capabilities`                                      | `full_html` a válaszban                          | —                                                   | hitelesített felfedezés: verzió, SEO-plugin, többnyelvű plugin, WooCommerce, feltöltési limit                       |
| SEO-meta             | 4 plugin, vakon                                          | 4 plugin, vakon                                  | 5 plugin natívan (AIOSEO tábla is) + tartalék       | csak az észlelt pluginnak; AIOSEO a saját modelljén át                                                              |
| Képek                | helyi mentés, forrás-URL dedupe; `sslverify=false`       | helyi mentés (2026-07 óta), max. 12              | letöltés vagy `push-image`                          | helyi mentés szélességgel, magassággal, alt-tal; TLS be, SVG nem                                                    |
| JSON-LD              | nincs                                                    | regexszel kivágva → meta → `wp_head` (most üres) | FAQPage mindig                                      | strukturált mezőként; a csatlakozó helyezi el                                                                       |
| Lemondás             | —                                                        | —                                                | csak szerveroldalon                                 | szerveroldalon (jogosultság a dequeue-nál, 16. inv.), és a plugin ne publikáljon ellenőrizhető aktív állapot nélkül |
| WooCommerce-olvasás  | nincs                                                    | nincs                                            | nincs                                               | **külön engedéllyel olvasni** — valódi különbség                                                                    |

### 5.2 Cikkfelépítés

| Elem                           | Outrank                           | BLG                            | GetAutoSEO            | Sortiva ma                                               |
| ------------------------------ | --------------------------------- | ------------------------------ | --------------------- | -------------------------------------------------------- |
| Hossz                          | 1 200–1 700 (min.)                | 2 200–2 400                    | 2 800–3 500           | a SERP-hez igazítva                                      |
| TL;DR / Key takeaways          | —                                 | TL;DR idézetblokk              | `key-takeaways` doboz | a bevezető a válasz; külön blokk nincs                   |
| Tartalomjegyzék                | —                                 | igen                           | igen, horgonyokkal    | nincs                                                    |
| Képek                          | AI (`cdnimg.co`, hotlink)         | 2–3 AI, Shopifyon hotlink      | borító + infografika  | **nincs**                                                |
| Videó                          | YouTube iframe                    | YouTube (néha hibás)           | —                     | nincs                                                    |
| Táblázat                       | összehasonlító                    | 0–2                            | ritkán                | Markdown — **a HTML-ben nem renderelődik** (4.1)         |
| GYIK                           | —                                 | 9/30 posztban                  | 6–8 kérdés, mindig    | feltételes                                               |
| Schema                         | nincs (a téma adja)               | hiányos Article; FAQPage nincs | FAQPage               | **nincs**                                                |
| Terméklink                     | ígért; élőben hiányzik vagy téves | ~0–1 / cikk                    | 1 kontextuális        | `{{pN}}` token, minden említésnél                        |
| Termékkártya, ár, készlet      | nincs                             | nincs                          | nincs                 | szöveges ár/készlet a tokenben                           |
| Külső hivatkozás               | `rel` nélkül                      | `nofollow`, vegyes minőség     | tekintélyforrások     | külső tény csak szó szerinti idézettel és forrás-URL-lel |
| Idegen csere-link              | **igen**                          | **igen**, dofollow             | **igen**, zárolt      | **soha**                                                 |
| Kitalált személyes tapasztalat | —                                 | **igen**, a tulaj nevével      | —                     | nem (állításterv)                                        |
| Indoklás a témára              | nincs                             | nincs                          | nincs                 | sablonból, a bizonyítékrekord fölött (8. inv.)           |

---

## 6. Ötletek részletesen

Méret: **S** = legfeljebb egy kártya; **M** = 2–3 kártya sémahullámmal; **L** = több sáv vagy új mérföldkő. Sávok a `docs/agent-work-plan.md` §3 szerint.

### 6.1 Valódi termékképek a cikkekben — M, alapítói döntés kell

- **Amit láttunk:** mindenkinél van kép; az AI-képek a kategória egyik visszatérő panaszai („completely illogical images"; Outrank: Remy hajhosszabbításról szóló cikkben fonott haj képe). A BLG és az Outrank a saját tárhelyéről hotlinkel.
- **Nálunk:** 4.4.
- **Spec:** main §9.2: „**Images: product images from the catalog only.** … alt text is generated from the fact sheet … **No AI image generation for now**". tech §2.1: „**Never proxy or store product images.** Articles hotlink Shopify CDN URLs".
- **Invariánsok:** 3 (az alt soha nem jöhet a `raw_body_html`-ből; hogy a Shopify kereskedő által írt kép-altja használható-e, az döntés), 19 (a frissítés maradjon „csak a mi szavaink" — az `image` frissítéskor felülírná a kereskedő által cserélt képet), 21 (új scope nem kell).
- **Lépések:** (a) sémahullám: `products.images jsonb` vagy melléktábla; (b) B sáv: képek megőrzése mindkét szinkronúton — a meglévő sorok csak a következő teljes szinkronnál töltődnek; (c) D sáv: evidence pack, elhelyezés (determinisztikus renderelő-elhelyezéssel prompt-váltás nélkül), `image` a create-payloadba, beágyazott `<img>`; (d) F sáv: bélyegképek.
- **Függ:** 4.1, dev store (T10.4). Megfordítja a 2026-09-04-i „for now" döntést.
- **Plusz a versenytársaktól:** a képet a _hivatkozott termékhez_ kell kötni és ellenőrizni.

### 6.2 Szakaszonkénti terméklink-terv és generálás utáni ellenőrzés — M

Ez a kutatás legerősebb termékötlete: **a versenytársak dokumentáltan itt buknak el**, nekünk pedig megvan hozzá az alap (tényadatlapok, állításterv, `article_product_refs`, 3. kapu).

- **Ötlet:** (1) írás előtt determinisztikus terv: szakasz → termék vagy kollekció → URL; (2) generálás után ellenőrzés: minden tervezett link jelen van, feloldható, és **a megfelelő szakaszban** áll (a Boston→Calgary eset egy címsor–terméknév egyeztetéssel kiszűrhető); (3) a 3. kapu lintje: N katalógustételt megnevező cikk nulla kataloguslinkkel megbukik vagy megy az egyetlen javítókörre; (4) kemény tiltás: kimenő link nem mutathat átfedő terméket áruló bolt termékoldalára.
- **Nálunk ma:** 4.5. A `required_link_missing` csak a Gate-1 linkfeladatot és egy kapcsolódó cikket fedi; a kollekciólink nincs kikényszerítve; nincs relevanciaszűrés.
- **Spec:** main §8.1: „mapped to one or more **product families** (§6.4), never raw products". DECISIONS 2026-09-01: „prose may not build an argument on a price".
- **Invariánsok:** 3, 9 (minden „legfeljebb N termék" szám a `packages/rules`-ba), 11 (meglévő kapu része, nem új kapu; egy javítókör).
- **„Link csak az első említésnél"** olcsó, determinisztikus szabály; ma minden említés link.

### 6.3 Látható termékkártya — M–L, alapítói döntés kell

- Senki nem csinálja a mezőnyben (a Bloggle kézi beágyazása a legközelebbi).
- **Előfeltételek:** 6.1, 4.1, és vagy a 4.3 javítása, vagy **ár nélküli kártya**. Lokalizált készlet- és akciószövegek kellenek — cikknyelvi sztringek ma nincsenek (ui: „V1 UI languages: English only").
- Renderelő-szintű kártya a „Products" szakasz után (a hibaelhárító forma kivételével mindben van ilyen szakasz a `shapes.ts`-ben).
- **Szerveroldali, statikus HTML legyen.** A Bloggle kártyája üres váz, amit JavaScript tölt ki — a keresőrobot és az AI-robot semmit nem lát belőle (3.5). A miénk a `body_html`-ben teljes értékű legyen: terméknév, kép, link szövegként.

### 6.4 JSON-LD — S (csak export) / M (automatikus publikálással), alapítói döntés kell

- **Amit láttunk:** GetAutoSEO mindig FAQPage-et ad; a BLG Article-blokkja hiányos (nincs `mainEntityOfPage`, `dateModified`; a dátum a generálásé), és duplikálja a téma `BlogPosting`-ját; az Outrank semmit.
- **Nálunk:** semmi. DECISIONS 2026-09-03: „Sortiva generates no structured data anywhere today". A 3. kapu `checkStructuredData`-ja csak `JSON.parse`-olja a prózába tett ` ```json ` blokkot.
- **Fontos:** a `content-pointers.md` §4 szerint „Google retired FAQ rich results for every site on 2026-05-07… do not spend effort on `FAQPage` markup expecting a rich snippet". (Naplózott projektvélekedés; most nem ellenőriztük.) A JSON-LD értéke tehát a gépi olvashatóság, nem a találati listás kiemelés.
- **Korlátok:** dev store-on ellenőrizni kell, megtartja-e a Shopify Article API a `<script>`-et a `body_html`-ben, és mit csinál vele az admin szerkesztő. A legtöbb téma már ad Article JSON-LD-t → duplikáció. A tiszta út (metafield + téma-snippet) a 21. invariáns miatt tilos. A Product `offers.price` illékony értéket égetne be (4.3).
- **Forma:** tiszta függvény a `core/publish`-ben, determinisztikus érvényességi teszttel; exportban negyedik fájl vagy metadata-kulcs. `BlogPosting` + `FAQPage` (csak ha van GYIK) + ár nélküli Product-csomópontok.
- **Előbb észlelni, mit ad a téma.** Az Auto Blogs Agent a törzsbe injektált `BlogPosting`-gal megduplázza a téma `Article`-jét — oldalanként két versengő cikk-entitás. Csak azt adjuk ki, ami hiányzik (jellemzően `FAQPage`), második cikk-entitást soha.
- **A WordPress-csatlakozónál** a schema strukturált mezőként menjen, és a csatlakozó helyezze el — a BLG regexes kivágása oda vezetett, hogy a WP-ügyfelek most semmit nem kapnak.

### 6.5 „Javítások" postafiók — S, döntés csak ha új menüpont

- **Nagyjából 90%-ban megvan:** szűrők (`packages/ui/src/opportunities/list.ts:88-139`), teendő szerinti csoportosítás, fiók bizonyítékkal, jelenlegi–javasolt nézet, letöltés, „alkalmazottnak jelölés", heurisztikus „úgy tűnik, alkalmaztad" (`core/optimize/applied.ts`), 28 napos kimenet (`optimize/outcome.ts`), figyelmeztető elem 14 napja alkalmazatlan javaslatra, REFRESH a saját cikkekre.
- **Megfeleltetés:**

| Outrank-típus              | Nálunk                                                                                 | Megjegyzés                                   |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| épp az első 5-ön kívül     | `striking_distance` (4–15. hely, 28 nap)                                               | OPTIMIZE bolti oldalra, REFRESH saját cikkre |
| alacsony CTR               | `low_ctr_at_strong_rank`                                                               | a bolt saját görbéjéhez mérve                |
| hanyatló helyezés          | `content_decay`                                                                        | két heti kiértékelés                         |
| hiányzó lekérdezés-lefedés | `existing_page_intent_gap` (+ `uncovered_commercial_query`, `competitor_coverage_gap`) |                                              |
| vékony oldal               | **nincs**                                                                              | új C sávos detektor + konfiguráció lenne     |

Nálunk ezen felül van `cannibalization`.

- **Átvenni érdemes:** a `readiness` mintát (ráképezhető az írási engedély + feloldott célblog előfeltételre); hosszabb távon a bekezdésszintű hunk-bírálatot — de ez ma ütközik: OPTIMIZE soha nem ír a Shopifyra (21. inv.), szerkesztő nincs (main §9.3). A hunkos nézet _megjelenítésként_ (mi változna) fér bele, elfogadás/szerkesztésként nem.
- **Amit nem veszünk át:** a kéthetes mérést (13. inv.) és a jel–teendő 1:1 összekötést (7. inv.).
- **Korlátok:** ui §9: „this list is exhaustive"; Appendix B: hat képernyő — hetedik menüpont ellentmondana. Mentett szűrő + szöveg elég. 23. inv.: nincs „7-ből 3 alkalmazva".

### 6.6 Cikkszintű kapcsolók — tételenként eltérő, mindhez alapítói döntés

- **Tartalomjegyzék — S.** Determinisztikus a szakaszcímekből, renderelési időben; címsor-horgonyok kellenek → 4.1. Opcionális blokk legyen: a témák gyakran saját tartalomjegyzéket renderelnek.
- **TL;DR — M.** A bevezető már a válasz; a külön pontlista ütközik a prompt ismétlés-tilalmával és a közel-duplikátum linttel. `draft.v3` + `revise` + bíró-frissítés + eval kell.
- **Záró jogi nyilatkozat — M.** Nem lehet LLM-szöveg; a kereskedőnek kell megadnia, renderelési időben hozzáfűzve. A `no-editor.test.ts`-en átmegy, de bírálat nélkül publikált kereskedői próza — rosszul ül a 11. invariáns szándékával. Új oszlop → sémahullám.
- **Kiemelt termék — M.** A témák családokra képződnek le; a családon kívüli termék mögött nincs állítás. Csak renderelő-kártyaként (6.3), új `topics` oszlopon.

### 6.7 Az első N cikk piszkozatként — S, alapítói döntés kell

- **Nálunk:** `delivery='export'`, `draft_review=false`, `shopify_publish_as='live'` (`accounts.ts:118-125`). Az export az alapértelmezés, tehát az ötlet csak akkor számít, amikor a kereskedő automatikus publikálásra vált.
- **Legolcsóbb változat:** a váltáskor előválasztani a „Shopify-piszkozat" módot vagy bekapcsolni a `draft_review`-t.
- **Valódi „első N":** származtatott számláló, N a `packages/rules`-ban (9. inv.); a szöveg nem hangozhat „N-ből M"-nek (23. inv.).
- **Spec:** main §9.3: „default off"; main §8.7: „There is no review window and no approval step".
- **Vigyázat:** a „hangnem kalibrálása" megfogalmazás mögött ma nincs mechanizmus (4.2).

### 6.8 Szöveges visszajelzés az írónak — lépésekben

1. **Hangnem, közönség, nyelv átadása** — 4.2; S; spec-megfelelés.
2. **Perszóna szerkesztése megerősítés után** — B sáv, S; a main §6.8 előírja.
3. **Állandó „írási jegyzetek" mező** — sémahullám + D és F, M; alapítói döntés. Kell: prompt-injekció elleni védelem; a szöveg csak stílusra vonatkozhat, soha nem idézhető (3. inv.).
4. **Piszkozatonkénti „módosítási kérés" — a mostani szabályokkal nem fér bele:** második javítókör (11. inv.: „one repair loop max"), a main §9.3 szerint a bírálat „approves or discards".

### 6.9 Előnézet egy valódi lehetőséggel — M, alapítói döntés + spec-módosítás

- **Amit láttunk:** a GetAutoSEO-nál ez a legjobb konverziós mechanika (URL → 3 cikk + terv, kártya nélkül).
- **Nálunk:** `runPreview` (`packages/core/src/preview/preview.ts:81`): normalizálás → IP-limit → Turnstile → 7 napos cache → költési megszakító → egy főoldal-lekérés → regex → Haiku (max. 8 000 karakter be, 150 token ki). Plafon: `budgets.preview_spend`, napi 10 USD. A `preview.v1.md`: „do not mention SEO, content, growth, rankings or this tool".
- **Kemény korlát:** a `disposable.test.ts` mindkét irányt kikényszeríti: „Nothing reads the preview" **és** „The preview reads nothing." A `PREVIEW_MAY_IMPORT` csak relatív importot, `node:`-ot és `@sortiva/providers`-t enged — az előnézet nem importálhat jelzés-, lehetőség- vagy SERP-kódot.
- **Spec:** main §3.2: „Strict budget per miss: one page fetch (homepage)"; §4.2: „the product does not give away free ingestion or free articles"; §12.1: „All calls are async job-side, never in a request/response path".
- **Ami belefér:** önálló heurisztika a `core/preview`-n belül (pl. termékszám + nincs útmutató-URL a sitemapben) — ehhez is módosítani kell a §3.2-t és §3.3-at, új sztringek és új költségkeret kell. Bármilyen keresési szám DataForSEO-hívást igényelne: fizetős olvasás, amit egy idegen nyilvános útvonalon vált ki.
- **Kockázat:** az előnézetben mutatott, de az ingestion által később nem reprodukált lehetőség bizalmat rombol.
- **Olcsóbb alternatíva marketingoldalon:** valódi bolti példákat mutató mintanézegető — kódot nem érint.

### 6.10 Ingyenes GSC-diagnosztika — L, alapítói döntés kell

- **Amit láttunk:** a BLG ingyenes MCP-je és az Outrank auditeszköze pontosan ez.
- **Újrahasználható:** `detectStrikingDistance` (`core/signals/striking-distance.ts:72`), `detectCannibalization` (`cannibalization.ts:154`), `detectContentDecay` (`decay.ts:90`), `storeBaseline`.
- **A bemenetek nem önállóak:** a klaszterek megerősített kulcsszavakból + `gsc_query_daily`-ből jönnek; a `PageIndex` a `store_pages`-ből (Shopify kell); a hanyatláshoz ≥2 heti kiértékelés; a kannibalizáció-validáláshoz 12 hetes bázis (backfill).
- **Hitelesítés:** minden GSC-útvonal `withAccount`; `gsc_conns.account_id` az elsődleges kulcs; tech §3: „Public endpoints (`/api/preview`) are the only unauthenticated surface". Nem-ügyfél Google-tokenjének tartása adatvédelmi tétel (founder-decisions E2).
- **Reális forma:** fiók + domain-igénylés + GSC a Checkout **előtt** — megfordítja a main §4.2 folyamatát.

### 6.11 A meglévő-célpont ellenőrzés nevesítése — S, csak a névhez kell döntés

- **Amit láttunk:** a RankYak „Site Guard" néven _terméket_ csinált belőle; nálunk erősebb (a CREATE előfeltétele, 6. inv.), de névtelen. Az Outranknél egy kapcsolat nélküli riport.
- **Nálunk:** `findExistingTarget` / `existingTargetCheck` (`packages/core/src/opportunities/existing-target.ts:288, 396`); ugyanaz a függvény az 1. kapuhoz és a vizsgálathoz. Rögzített bizonyíték (304–323. sor): `existing_target_match`, `_url`, `_via`, `_position`, `_weakness`, `_presence`. UI: miért-sor kulcsok (`packages/ui/src/opportunities/why.ts:27,40`), „converted" chip, bizonyítéksorok. Összesített szám és funkciónév nincs.
- **Korlátok:** az A függelék miért-sora kanonikus (24. inv.) — a név _köré_ kerül. Puszta darabszám a 23. inv. szűk olvasatában megengedett (lásd R-GUARD-TEETH, DECISIONS 2026-09-08). Minden szöveg sablonból (8. inv.).
- **Forma:** F sáv sztringek + kis C sávos számláló a `reason_template_key` fölött (meglévő oszlop).
- **A RankYaktől átvehető a megjelenítésben:** az „összevonandó" és a „csak figyeljük" esetek szétválasztása (átfedés van, de a kereslet különböző), valamint annak kiírása, _melyik jel döntött_ — nálunk ez a rögzített `_via` / `_weakness` bizonyítékból sablonnal kiírható. Átirányítást továbbra sem javaslunk végrehajtásra (21. inv.).
- **A kannibalizáció-detektor finomhangolásához** a 3.5 nyílt forrású küszöbei (márkalekérdezések kizárása, oldalankénti minimális megjelenés és részesedés, domináns részesedés felső határa, „részleges adaton nincs minden-rendben") jó összevetési alap a `signals.config.yaml` mostani értékeihez. C sáv; minden szám a `packages/rules`-ban marad.

### 6.12 Lemondás — S

- **Amit láttunk:** a kategória első számú panasza. A TheSEOAgent már hirdeti: „cancel in app".
- **Nálunk:** `POST /api/billing/portal` megnyitja a Stripe Customer Portalt. Jogosult = pontosan `active` (`billing/entitlement.ts:30-40`). Dequeue-kapuk: `generation/cycle.ts:78-83`, `publish/schedule.ts:59`. Folyamatban lévő intenteket a helyreállító söprő lezárja; új kézbesítés `not_entitled`.
- **Ütközés:** a „publikálás azonnal leáll" ellentmond az A függelék kanonikus szövegének: „_Generation stops at the end of your billing period._" (24. inv.) és a main §4.2-nek. **Azonnali leállás már ma is van: a szabadság mód.**
- **Döntés nélkül:** Portal-mélylink (`flow_data: subscription_cancel`) — egy kattintás új fizetési felület nélkül. Mellé egy „Mi történik, ha lemondod" oldal a `CANCELLATION_FACTS` alapján: a generálás a számlázási időszak végén áll le; az olvasási hozzáférés **soha** nem szűnik meg (16. inv.); azonnali megálláshoz ott a szabadság mód.
- **Előnyünk:** a jogosultságot nálunk a dequeue-nál, szerveroldalon, helyi sorból ellenőrizzük — a GetAutoSEO-féle „lemondás után is publikált" hibaosztály így nem állhat elő. A WordPress-csatlakozónál erre külön figyelni kell (8.1).

### 6.13 Próba és garancia — döntés

- **Spec:** main §4.2: „**No trial period (decided):** … the product does not give away free ingestion or free articles." founder-decisions C9: „$89/month, 20% off annual. | The spec itself says this isn't final — it argues the product belongs in a $149–$399 band once AI visibility, revenue intelligence and technical execution ship."
- **Amit a mezőny mutat:** az 1 dolláros, 3 napos, automatikusan megújuló próba „scam"-véleményeket termel; a BLG garanciája érvényesíthetetlen. A SEObot „visszatérítés az első cikk után" és a Soro 14 napos pénzvisszafizetése tisztább.
- **Változatok:** kézi visszatérítés a Stripe felületén — **kód nélkül**, S (csak szöveg). Automatizált: új provider-metódus + allow-list, a „nem megy át a bírálatodon" definíciója (a bírálat alapból **ki** van kapcsolva!), `charge.refunded` kezelés. Próba: `trial_period_days`, `trialing` leképezés, DB-enum bővítés, `isEntitled` — és a drága ingestion az első hétre esik; M.
- Forgalomszázalékos garancia ütközne a 13. invariánssal.
- **Árazás:** a 99 USD / 30 cikk horgony mellett a 89 USD / „legfeljebb napi 1" nem olcsóbb ajánlatnak látszik, hanem kevesebbnek — hacsak a kommunikáció nem fordítja meg. A GetAutoSEO 149 USD-ja mutatja, hogy a sáv alja tartható.

### 6.14 Nyilvános cikkenkénti eredmények — M, döntés; előbb saját használat

- **Amit láttunk:** senki nem mutat cikkenkénti eredményt; darabszámot, megjelenést, DR-t jelentenek.
- **Spec:** main §17.3: „**shows no revenue at launch**… labelled 'influenced/attributed' — never 'incremental'"; main §20: „Revenue = attribute all growth to Sortiva. | No."
- **Invariánsok:** 12 (felülbírálással publikált cikk kizárva), 13 (a címkék boltonként a saját mediánhoz viszonyítanak → a boltok közötti „nyerési arány" nem összehasonlítható), 23, 26 (nyilvános bizonyítékoldalhoz kifejezett kereskedői hozzájárulás + DB-oldali export; hozzájárulási mező nincs).
- Még nincs fiók — először magunkon kell futtatni.

### 6.15 Ügynök-barát API — később, de olcsó

- `agent_guidance` minden válaszban — majdnem ingyenes, ha az indoklások amúgy is sablonból renderelődnek (8. inv.); önleíró beállítások `_meta`-val; költésnél árajánlat → megerősítés + idempotencia-kulcs; `validate` / `test` / `prepare` / `connect`+lekérdezés igekészlet; `SKILL.md` az npm-csomagban.
- **Kerülendő:** három nap alatti törő átnevezés, kódnak ellentmondó README, „rejtett" mezők, amelyekre csak megkérjük az ügynököt, hogy ne tippeljen.
- A V1-ben nincs nyilvános API.

### 6.16 `.md` változat a cikkekhez — csak saját hosztolású csatlakozónál

- A GetAutoSEO WP-pluginja bármely cikk-URL + `.md`-re Markdownt szolgál ki. Shopify-blogon ez nem megoldható téma-módosítás nélkül (21. inv.); WordPress-csatlakozónál olcsó kiegészítés. A Markdown-exportunk már létezik és helyes.

### 6.17 Bolti „ténynapló": ugyanaz a szám minden cikkben — ellenőrizni, utána S–M

- **Amit láttunk:** a Soro Shopify-véleményeiben név szerint szerepel: „numbers are inconsistent across articles on the same topic … keep a single source of truth for facts". A BLG-nél tényszerűen hibás állítások miatt töröltek cikkeket; a GetAutoSEO-nál „got it wrong 5 times" élelmiszernél.
- **Nálunk:** a termékre vonatkozó tények a tényadatlapokból jönnek, és az író csak jóváhagyott állítást tehet — a _terméktényeknél_ az egyetlen forrás tehát megvan. Ami nincs ellenőrizve: a **külső** tények (szó szerinti idézettel és forrás-URL-lel) cikkek közötti következetessége — két cikk ugyanarra a kérdésre két forrásból két számot hozhat.
- **Ötlet:** fiókonkénti napló a már felhasznált külső tényekről (állítás, forrás, dátum); az állítástervnél előnyben részesíteni a már használtat, és a 3. kapu ellentmondás-lintjét kiterjeszteni a korábbi cikkekre. Új tábla → sémahullám. **Előbb ellenőrizni kell**, hogy a meglévő ellentmondás-lint mit fed le — ezt a kutatás nem nézte meg.
- Eladható állítás: „ugyanazt a tényt minden cikkedben ugyanúgy írjuk".

### 6.18 Marketing és értékesítés — kódot nem érint

- **„A Sortiva soha nem tesz idegen linket a cikkeidbe."** A legerősebb, kóddal bizonyítható állítás. A versenytársaknál ez nyers HTML-ben percek alatt ellenőrizhető.
- **„Nem találunk ki személyes tapasztalatot a nevedben."** A BLG a tulajdonos nevével aláírt, kitalált szakaszokat publikál; nálunk az állításterv ezt kizárja.
- **„Legfeljebb napi 1, ha átmegy a szűrőn."** A kihagyott nap minőségjelzés. Alátámasztás: „very sharp drop in Google Search Console impressions", „thin… will not index them".
- **Olvasás és írás külön engedély.** Az Outrank egyszerre kér négy scope-ot, tokenbemásolással („invalid token", „does not install").
- **Ne állítsunk ChatGPT-említésszámot mérés nélkül** — egyezik a V2-pozicionálással.
- **Shopify Akadémia-minta** (BLG: 91 URL).
- **Szegmens-landingek és magyar jelenlét.** A magyar alapítású GetAutoSEO-nak sincs magyar oldala; Shoprenterre és UNAS-ra senki nem publikál.
- **Affiliate:** ha lesz, márkakulcsszó-tiltással és kötelező feltüntetéssel. Ösztönzött véleményt soha (a BLG elvesztette a Trustpilot-értékelését).
- **Ingyenes eszköz, ami teendőt ad ki** (Outrank: beilleszthető javító prompt).

---

## 7. Amit a versenytársak csinálnak, és a specünk kifejezetten tilt

- **Backlink és külső munka.** main §17: „off-site opportunities" csak V2. DECISIONS 2026-09-03: „digital PR is human outreach, not a tool feature". main §1.2: „Not a general SEO suite".
- **AI-képek.** main §9.2: „**No AI image generation for now**". main §18: „Not core growth value; extra quality and cost risk." A `generation/images.ts` fejlécét grep-teszt őrzi.
- **Auditriport.** main §1.2: „a 200-issue audit report is an anti-pattern here". main §18: „Full technical-SEO crawler / site audit | Scope explosion and a commoditised feature".
- **Szerkesztő.** main §9.3: „there is deliberately **no in-app editor** (decided)". main §18: „Shopify already is the editor". Őrzi: `no-editor.test.ts`.
- **Nevezők.** main §8.6: „with no denominator — 1/day is a ceiling, not a promise". main §1.2: „not a '30 articles/month' commodity Shopify app". 23. invariáns.
- **LLM által írt indoklás.** main §7.1: „from template strings — never generic LLM prose". 8. invariáns.
- **Téma-módosítás és átirányítás.** main §11: „**Never auto-modify theme or custom code**, and never execute redirects/canonicals — recommendation only". 21. invariáns.
- **Több webhely, ügynökségi mód.** main §1.5: „One store per account, one account per domain". 1. invariáns.
- **Automatikusan alkalmazott oldalszerkesztés.** main §10.1: „**Auto-editing store pages is NOT in V1**".
- **Modell-visszaminősítés.** main §14.4: „degrade to pause, never to lower quality". 22. invariáns.
- **Dollárbecslés.** main §7.6: „**No dollar estimate in V1**".

Ezek többsége a versenytársak véleményeiben panaszként köszön vissza — a tiltások tehát eladható állítások.

---

## 8. Nagy tételek

### 8.1 WordPress / WooCommerce csatlakozó — L, új mérföldkő, alapítói döntés

**Hol tartunk.** Enum: `['shopify','custom_unsupported']`. Az írási varrat a `ShopifyPublishProvider`; `packages/core/src/publish/ports.ts:1-12`: „Everything behind it is Shopify's vocabulary". Sémanevek: `publish_intents.shopify_article_id`, `products.shopify_product_id`, `store_pages.shopify_id`… 125 nem-teszt fájl említi a Shopifyt. **Már semleges:** a kétfázisú protokoll (`core/publish/intent.ts`, jelölő, söprő, frissítés soha nem esik vissza létrehozásra), a `CatalogEvents` szerződés, tények, családok, lehetőségek. **Spec:** main §6.1: „Don't build WooCommerce/Wix detection scaffolding yet"; main §18: „Shopify PMF first".

**Tervezési tanulságok a három plugin forrásából**

1. **Azonosítás csak saját metával** (`_sortiva_article_id` + `_sortiva_content_hash`), soha nem slug vagy cím. Slug-ütközés idegen poszttal = 409. Ez a 19. invariáns WordPressre fordítva — a BLG mindkét irányban megsérti, az Outrank négy kiadást költött rá.
2. **Eltérés-észlelés frissítés előtt:** tárolt hash vs. jelenlegi `post_content`; ha ember szerkesztette, szünet és jelzés (22. inv.). Státuszhoz, kategóriához, címkéhez csak akkor nyúlunk, ha mi állítottuk be és változatlan. Minta: a GetAutoSEO `_manual_content_override`-ja.
3. **Aláírt kézbesítés:** HMAC az időbélyeg + törzs fölött, kézbesítési azonosítóval; a plugin válasza hordozza a jelölőnket, hogy a söprő ellenőrizhesse a távoli állapotot.
4. **Hitelesített felfedezés, nem nyilvános ping.** Adja vissza: plugin-verzió, SEO-plugin, többnyelvű plugin, WooCommerce aktív-e, feltöltési limit.
5. **Törlés, visszavonás és visszaolvasó útvonal az első naptól.** Törölt posztot soha nem élesztünk fel.
6. **Párosítás:** aláírt kihívás szerveren kiadott, egyszer használatos, lejáró tokennel **és** a WP-ben generált titokkal, amit a SaaS soha nem választ meg. Titok soha nem kerül naplóba; a debug alapból ki.
7. **Tűzfal-lépés a beállításban.** A BLG két fix IP-t és nyolc biztonsági pluginhoz ad útmutatót — a WAF által blokkolt `/wp-json` POST a fő támogatási terhük [KÖV]. Érdemes pull módot is kínálni. _Ne_ kérjünk Cloudflare API-tokent (az Outrank ezt teszi).
8. **KSES-t soha nem lazítunk globálisan**; „unfiltered HTML" kapcsolót nem kínálunk.
9. **SEO-meta csak az észlelt pluginnak;** AIOSEO v4 a saját tábláját használja. Ne írjuk felül a címsablont.
10. **Többnyelvűség a WPML/Polylang nyilvános API-ján át**; TranslatePress és Weglot: jelezzük, hogy nem támogatott.
11. **Tartalom és metaadat külön:** egy szemantikus HTML-törzs H1 és borítókép nélkül; borító, alt, schema, források strukturált mezőként.
12. **Képek a kereskedő platformján**, szélességgel, magassággal, alt-tal; ne hotlinkeljünk saját tárhelyet; kerüljük az ujjlenyomatként működő fájlnévmintát.
13. **Csatlakozónkénti HTML-szerződésteszt** (4.1).
14. **WooCommerce-olvasás külön engedéllyel (21. inv.) — egyik versenytárs sem csinálja.** Termékek a WC REST v3-ból; rendelések **a vásárlói mezők olvasáskori levágásával** (4. inv.; `_fields`); webhookok más HMAC-cal; nincs `app/uninstalled` és GDPR-téma megfelelő. Figyelem: a WP alkalmazásjelszavak nem választják szét az olvasást és az írást.
15. **Lemondás:** a jogosultság szerveroldalon már érvényesül; a plugin ne publikáljon helyben ellenőrizhető aktív állapot nélkül.
16. **Teljes takarítás eltávolításkor** — a posztok és a média maradnak; a web gyökerébe írt fájlok (pl. IndexNow-kulcs) is törlődjenek.
17. **Frissítéskor csak tartalmi mezőket küldünk, státuszt soha.** A TheSEOAgent és a BLG a kereskedő által visszavont posztot újra élesíti.
18. **A létrehozás legyen idempotens a saját azonosítónkon** (Soro-minta): elveszett válasz után az ismétlés a meglévő posztot adja vissza. Slug-ütközésnél piszkozat, nem felülírás.
19. **A SEO-metát a beszúráson belül írjuk** (`meta_input`), hogy a SEO-pluginok `save_post` hookjai lássák, utána a Yoast indexable újraépítése. Külön meta-címet küldünk, ne az H1 másolatát. Kulcsok csak az `is_plugin_active` pluginnak — az Arvow listája a legteljesebb (Yoast, AIOSEO, Rank Math, SEOPress, The SEO Framework, Squirrly).
20. **Soha nem tartunk WordPress alkalmazásjelszót** (RankYak-minta): az teljes jogú hitelesítő adat a mi oldalunkon. A beállítómenü `manage_options`-t kérjen; üres tárolt titkot a fogadó utasítson el (az Arvow hitelesítés-megkerülése ebből lett); a `post_type`-ot ne fogadjuk el a kérésből.
21. **Ne írjuk felül más plugin biztonsági döntését** (a Soro feloldja a lezárt REST API-t) — ha a REST le van zárva, jelezzük, és kínáljuk a pull módot.

### 8.2 Shopify App Store — L, alapítói döntés + alkotmánymódosítás

A Shopify-követelmények általános tudásból valók — ellenőrizni kell.

| Követelmény                     | Nálunk                                                                                                        | Hol                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A telepítés a Shopifyból indul  | Az OAuth-indítás Sortiva-munkamenetet igényel; a tölcsér: regisztráció → Stripe → igénylés → észlelés → OAuth | `apps/web/app/api/shopify/oauth/start/route.ts:13`; main §4.2, §5, §6 |
| Shopify Billing API             | Csak Stripe; a 16. inv. a Stripe webhook-workert nevezi meg egyedüli íróként                                  | `packages/core/src/billing/*`                                         |
| Beágyazott felület              | Önálló app süti-munkamenettel                                                                                 | tech §3; ui §1                                                        |
| GraphQL Admin API               | Csak REST, `2025-01`                                                                                          | `providers/src/shopify/oauth.ts:22`, `publish.ts:37-40`               |
| GDPR-webhookok                  | Megépítve; listázással soha nem ellenőrizve                                                                   | founder-decisions                                                     |
| Scope-ok                        | Csak olvasó telepítés; `write_content` második engedélyként                                                   | `core/src/catalog/scopes.ts`                                          |
| Domain-igénylés a Shopify előtt | Shopify-first telepítésnél először a `*.myshopify.com` ismert                                                 | 1. inv.                                                               |

Becslés: telepítés megfordítása M; GraphQL-migráció L; Shopify-számlázás második jogosultság-íróként M–L (a 16. inv. módosítása); beágyazott héj L. Az **egyedi terjesztésű app** korai szakaszban a nagy részét elkerüli.

**Mit csinál a mezőny:** öt riválisból három (RankYak, SEObot, Arvow) — és a BLG is — a kereskedő által létrehozott egyedi appal és Stripe-számlázással kerüli meg az App Store-t; a TheSEOAgent App Store-appot állít, de listázást nem találtunk. Shopify-számlázást csak a Soro és az Auto Blogs Agent használ. Az egyedi appos út tehát a kategóriában bevett — cserébe nincs App Store-láthatóság, és a kereskedőnek kézzel kell appot létrehoznia és tokent másolnia (ebből jönnek az „invalid token" vélemények).

**Miért számít most jobban:** az App Store-ban a mezőny gyenge — GetAutoSEO 2,3 / 3, Outrank 3,6 / 8, egyik sem „Built for Shopify", mindkettőnél telepítési hibákról szóló egycsillagosok.

---

## 9. Javasolt sorrend

**0. kör — saját hibák; nélkülük a többi nem ér semmit**

1. 4.1 ellenőrzése fixture-rel; ha igaz, HTML-renderelés javítása + szerződésteszt.
2. 4.2: hangnem, közönség, nyelv átadása az írónak (`draft.v3`); ehhez a `pnpm eval` életre keltése.
3. 4.5: beégetett angol sztringek a cikkekben.
4. Perszóna-szerkesztés megerősítés után.

**1. kör — a legnagyobb látható különbség** 5. 6.1 Képek (sémahullám). 6. 6.2 Szakaszonkénti terméklink-terv + ellenőrzés; „link csak az első említésnél"; kollekciólink kikényszerítése; versenytárs-termékoldal tiltása. 7. 6.4 JSON-LD exportban; automatikus publikálásnál dev store után.

**2. kör — olcsó, látható** 8. 6.12 Lemondási mélylink + „mi történik, ha lemondod". 9. 6.11 A meglévő-célpont ellenőrzés nevesítése. 10. 6.5 „Javítások" mentett szűrő; `readiness` jelzés. 11. 6.6 Tartalomjegyzék. 12. 6.7 Piszkozat-alapértelmezés az automatikus publikálásra váltáskor.

**3. kör — alapítói döntés után** 13. 6.3 Termékkártya. 14. 6.8/3 Írási jegyzetek. 15. 6.13 Garancia és ár. 16. 6.9 Előnézet. 17. 8.2 App Store. 18. 8.1 WordPress/WooCommerce.

**Ellenőrzés után:** 6.17 ténynapló — előbb megnézni, mit fed le a meglévő ellentmondás-lint.

**Párhuzamosan, kód nélkül:** 6.18 üzenetei, mintacikk-nézegető valódi bolti példákkal, magyar nyelvű jelenlét.

**Kihagyva:** AI-láthatóság-követés (következő modul); `llms.txt` Shopifyra (a platform ma már maga szolgálja ki, 3.5); Reddit/Quora-ügynök, 50–150 nyelv, tíz CMS egyszerre, white-label, linkcsere — soha.

---

## 10. Alapítói döntések

| #   | Kérdés                                                                                           | Miért    |
| --- | ------------------------------------------------------------------------------------------------ | -------- |
| 1   | A „kép nélkül, egyelőre" (2026-09-04) megfordítása; alt forrása; frissítéskor nyúlunk-e a képhez | 6.1      |
| 2   | Termékkártya: árral (és akkor újrarenderelés árváltozáskor) vagy ár nélkül                       | 6.3, 4.3 |
| 3   | JSON-LD: csak export vagy automatikus publikálás is                                              | 6.4      |
| 4   | Cikkszintű kapcsolók — melyik kerül az ui §9 kimerítő listájára                                  | 6.6      |
| 5   | Piszkozat-alapértelmezés váltáskor                                                               | 6.7      |
| 6   | Állandó „írási jegyzetek" mező                                                                   | 6.8      |
| 7   | Előnézet: a main §3.2 költségkeretének módosítása                                                | 6.9      |
| 8   | Ingyenes GSC-diagnosztika a Checkout előtt                                                       | 6.10     |
| 9   | A meglévő-célpont ellenőrzés termékneve                                                          | 6.11     |
| 10  | Próba, garancia, indulóár (C9)                                                                   | 6.13     |
| 11  | Nyilvános eredmények és a hozzájárulási mező                                                     | 6.14     |
| 12  | App Store-út vagy egyedi terjesztés; a 16. inv. módosítása                                       | 8.2      |
| 13  | WordPress/WooCommerce mérföldkő időzítése                                                        | 8.1      |

Nem kell döntés (spec-megfelelés vagy hibajavítás): 4.1, 4.2, 4.5, perszóna-szerkesztés, lemondási mélylink.
