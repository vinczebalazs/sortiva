# Sortiva — rövid összefoglaló a döntésekhez

2026. szeptember 25. Ez a `docs/mvp-plan.md` lényege, technikai részletek nélkül. A teljes terv angolul, a részletekkel, ott olvasható.

---

## Mit építünk

Egy alkalmazást, amit a webshop-tulajdonos feltelepít a boltjára. Az app elolvassa a termékeit, kitalálja, miről érdemes a boltnak cikket írnia, és naponta legfeljebb egy cikket megír, ha van mit. A cikket vagy magától kiteszi a bolt blogjára, vagy odaadja fájlként, hogy a tulaj tegye ki. A Google Search Console mutatja meg utólag, melyik cikk hozott keresést és kattintást. A kulcsszó-adatokat a DataForSEO szolgáltatja.

Első platform a Shopify, a Shopify adminba beágyazott appként. Más boltrendszerek később jönnek; ehhez saját belépés és fizetés kell majd, ezt elhalasztjuk.

Ami **nincs** benne: tanácsok meglévő oldalakhoz, technikai SEO-javítás, e-mail összefoglalók, képgenerálás, beépített szerkesztő, bevétel-mérés, több bolt egy fiókban.

## Hol tartunk most

Az eddigi rendszer nagy: körülbelül 197 000 sor kód, 57 adatbázis-tábla, 19 időzített folyamat, 194 finomhangolt szám. Ennek nagyjából a fele olyan funkció, amire az első verzióhoz nincs szükség, és ezek össze vannak nőve egymással. A rendszer **soha nem futott le végig egy valódi bolton**: senki nem látott még egy cikket, amit ez a termék kitett volna.

A szeptemberi hibavadászat 106 hibát talált. Ezek jó része ott van, ahol a részek találkoznak, nem az egyes részekben. A tesztek zöldek voltak, mert minden részt külön, a szomszédja helyett egy bábuval teszteltek. Példák, amik átcsúsztak: a Shopify egy már kivezetett API-verzióján beszélt; a hozzáférési kulcs egy óra után lejárt, és ezt a kód „leválasztott boltként” értette; a cikk HTML-je a formázást szó szerint, karakterekként tette volna ki.

A külső „héj” (e-mailes belépés, domain-megadás, nyilvános előnézet, kétlépcsős engedélykérés) egyébként is menne a kukába, mert a Shopify-appnak másképp kell működnie.

## A javaslat

**Építsük újra egy kis magból, és mentsük át azt a nagyjából tíz részt, ami tényleg jó.** Nem a 80 nyitott hibát javítgatni, és nem a mostani rendszerből kivagdosni, amíg kicsi nem lesz.

Amit átmentünk: a Shopify-kapcsolat (a kulcsfrissítéssel együtt), a kétlépéses közzététel (ami miatt egy összeomlás sem tehet ki kétszer egy cikket), a termékleírásból tényeket kinyerő rész, a cikkeket pontozó „bíró”, a DataForSEO- és a Search Console-kapcsolat, a modellhívások egyetlen kapuja, és az a tesztsegéd, ami minden tesztnek saját adatbázist ad.

Amit kidobunk: a „növekedési lehetőség” motor (kb. 7500 sor), a meglévő oldalak tanácsadója és a technikai SEO (3100 sor), a cikkek utólagos „javítója” (1600 sor), a tanuló rendszer, az e-mail-küldés, a nyilvános előnézet, a 979 soros szabályfájl, a termékcsaládok. 57 tábla helyett 16.

**Becsült méret:** négy fejlesztési szakasz, egyenként 5–7 ügynök-munkanap, utána 2–3 hét próba valódi boltokkal. Hetek, nem hónapok. A tesztkeretet építjük először.

## A biztonsági korlátok, amik maradnak

Ezek azok a szabályok, amik egy valódi kereskedőnek kárt okozhatnának, ha csendben sérülnének. A 26 mostani szabály helyett nyolc:

1. Az író csak ellenőrzött tényeket lát, a marketing-szöveget soha.
2. Minden termékállítás és minden szám a cikkben egy tényre hivatkozik; ezt gép ellenőrzi.
3. Egyetlen link sem mutat ki a bolt saját domainjéről.
4. Boltonként naponta legfeljebb egy cikk.
5. A közzététel kétlépéses; egy frissítés soha nem hoz létre új cikket.
6. Soha nem írunk felül semmit, amit a kereskedő maga írt vagy szerkesztett.
7. Minden külső hívásnak ára van és napi kerete boltonként.
8. Ha valami nem stimmel, a rendszer megáll és megmondja, miért. Nem ír gyengébb modellel, nem használ régi adatot, nem tesz ki erőből.

Ezekre külön figyelünk: ugyanarról a témáról kétszer nem írunk; nem írunk két cikket, ami egymással versenyezne a Google-ben; nem írunk olyanról, amiről a boltnak már van oldala; egy kevés termékes bolt kevés témát kap, nem általános tölteléket; kitalált tények, számok, „személyes tapasztalat” nem mehet ki.

## Döntések, amik rátok várnak

**D1 — Újraépítés a fentiek szerint?** Alternatíva: a 80 hibát helyben javítani. Javaslat: újraépítés.

**D2 — A cikk-sor legyen a termék középpontja?** Az eredeti terv szerint a „növekedési lehetőség” a főszereplő, a cikk csak egy eszköz. Az első verzióban ez egy rangsorolt témalista lenne. Ára: egyelőre „AI blogíró Shopifyra” vagyunk, csak olyan, ami nem talál ki tényeket, nem linkel kifelé, és méri magát. A nagyobb pozicionálás visszajöhet, ha a kör már lefutott valódi boltokon. Javaslat: a cikk-sor.

**D3 — Rendelések és bevétel kimaradnak?** Ha bent maradnak, Shopify-engedély kell a vásárlói adatokhoz és GDPR-kezelés. Az első verzió nem mutat bevételt. Javaslat: kimaradnak.

**D4 — Search Console kötelező vagy választható a telepítésnél?** Választható: kevesebb súrlódás, de mérés nélkül fut a bolt, és ezt kiírjuk. Javaslat: választható.

**D5 — Képek a cikkekben?** A bolt saját termékképei, link szerint, semmi generált kép. Javaslat: igen, így.

**D6 — Ár a cikk szövegében?** Soha; a termékkártya a bolt oldalára mutat, ahol az ár mindig friss. Javaslat: soha.

**D7 — Háttérfolyamatok motorja.** Technikai, a javaslat a mostani maradjon, egyszerűsítve.

**D8 — Az első valódi bolt.** Van barátságos bolt, és milyen nyelvű? Az első bolt nyelve dönti el, melyik piacot kalibráljuk először.

**D9 — A nyolc szabály fent** elfogadható, vagy húzzatok ki belőle.

## Amit csak ti tudtok megadni a teszteléshez

- Shopify Partner-fiók, az app létrehozása, két fejlesztői bolt; az app egyszeri feltelepítése egy fejlesztői boltra (ehhez a ti böngésző-belépésetek kell).
- Anthropic- és DataForSEO-kulcs kis kerettel (a tesztek pénzbe kerülnek, dollárokba, nem többe).
- Egy Google Cloud-projekt a Search Console API-val, **és egy saját weboldal, aminek van valódi kereső-forgalma**, mert a Google-nak nincs tesztkörnyezete, és egy friss fejlesztői boltnak nincs keresési adata.
- Kb. 20 cikk emberi osztályozása: „ezt egy kereskedő szívesen kitenné?” — ezt gép nem tudja eldönteni.
- Az első három kitett cikk megnézése a bolt blogjában, a saját témájában. A formázási hiba azért maradt életben, mert ezt senki nem tette meg.
- Railway, domain, titkok; próbaboltok.

Minden más — a tesztek megírása, futtatása, a hamis szolgáltatások karbantartása, a cikkek összegyűjtése egy áttekintő oldalra, hogy csak olvasni kelljen — ügynökkel megy.

---

## Döntések — 2026. október 8.

Az alapító válaszai, a teljes tervbe (`docs/mvp-plan.md` 7. rész) és a döntésnaplóba is bekerültek.

- **D1** — Teljes újraépítés egy teljesen új könyvtárban. **Egyetlen sort sem viszünk át**: se kódot, se promptot, se a korábban osztályozott tesztcikkeket. A régi kód csak olvasható referencia marad.
- **D2** — Csak a cikk-sor készül, de úgy, hogy a „növekedési motor” később bővítésként jöhessen (minden témának van forrása és bizonyítéka; a keresési adatok oldalanként és keresésenként tárolódnak).
- **D3** — Rendelés és bevétel kimarad.
- **D4** — Search Console választható; nélküle a bolt „korlátozott” módban fut, és ezt kiírjuk.
- **D5** — Nincs generált kép; a bolt termékképei, a kártyához képarány szerint legjobban illő kép.
- **D6** — Ár soha nem szerepel a cikk szövegében.
- **D7** — A háttérfolyamatok motorja marad (Graphile Worker).
- **D8** — **Magyar és angol egyaránt az első verzió része**, az első próbabolt magyar. Más nyelv egyelőre nincs. Minden tesztkészletnek magyar fele is kell, magyar anyanyelvű osztályozóval.
- **D9** — A nyolc szabály marad, minden más régi szabály megy. Az 5. szabály (kétlépéses közzététel) kifejtve: közzététel előtt feljegyezzük, hogy „most tesszük ki X cikket”, a hívás viszi a saját azonosítónkat, siker után tároljuk a bolt azonosítóját; egy összeomlás így késleltethet, de duplikálni nem tud. Ha később a bolt azt mondja, a cikk már nincs meg, azt a kereskedő törölte: feljegyezzük és megállunk, soha nem hozunk létre helyette újat.
