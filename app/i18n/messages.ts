export type UiLanguage = 'en' | 'hu'

const en = {
  stepOf: (n: number, of: number) => `Step ${n} of ${of}`,
  loading: 'Loading…',
  signInFailed: 'We could not open Sortiva for this store. Reload the page; if it keeps happening, reinstall the app.',
  reading: {
    title: 'Reading your store',
    subtitle: 'This runs in the background. You can close this page and come back; we pick up where we were.',
    products: (done: number, total: number) => (total ? `Reading products (${done} of ${total})` : 'Reading products'),
    facts: 'Understanding each product',
    factsDetail: (done: number, total: number) => (total ? `${done} of ${total}` : ''),
    profile: 'Drafting your store profile',
  },
  noProducts: {
    title: 'Add products to your store first',
    body: 'We write only about what your store sells, and it has no products yet. Add some in Shopify, then come back here.',
    action: 'Go to Products in Shopify',
  },
  profile: {
    title: 'Confirm your store profile',
    subtitle: 'This is what we understood from your catalogue. Nothing is written until you confirm it, and you can change it later in Settings.',
    draft: 'Draft',
    sells: 'What you sell',
    audience: 'Who buys it',
    language: 'Language of your articles',
    languageUnsupported: 'We write in English and Hungarian for now. Pick the one your articles should be in.',
    country: 'Country of your customers',
    countryHint: 'Two-letter country code, for example GB or HU.',
    tone: 'Tone',
    tones: {
      plain: { label: 'Plain', description: 'Clear and to the point.' },
      friendly: { label: 'Friendly', description: 'Warm, like talking to a regular.' },
      expert: { label: 'Expert', description: 'Precise, for people who know the subject.' },
    },
    neverSay: 'Things we must never say',
    neverSayHint: 'Optional. Competitor names, claims you do not want made, words you avoid.',
    confirm: 'Confirm',
    saving: 'Saving…',
    required: 'Please fill this in.',
    unsupported: 'Choose English or Hungarian.',
  },
  languages: { en: 'English', hu: 'Hungarian' },
  next: {
    title: 'Profile confirmed',
    body: 'Next: connect Google Search Console and choose how articles reach your store.',
  },
}

const hu: typeof en = {
  stepOf: (n, of) => `${n}. lépés / ${of}`,
  loading: 'Betöltés…',
  signInFailed: 'Nem sikerült megnyitni a Sortivát ehhez a bolthoz. Töltsd újra az oldalt; ha újra előfordul, telepítsd újra az alkalmazást.',
  reading: {
    title: 'Beolvassuk a boltodat',
    subtitle: 'Ez a háttérben fut. Bezárhatod az oldalt, és később visszajöhetsz; ott folytatjuk, ahol tartottunk.',
    products: (done, total) => (total ? `Termékek beolvasása (${done} / ${total})` : 'Termékek beolvasása'),
    facts: 'Minden termék megértése',
    factsDetail: (done, total) => (total ? `${done} / ${total}` : ''),
    profile: 'A boltprofil megfogalmazása',
  },
  noProducts: {
    title: 'Előbb tölts fel termékeket',
    body: 'Csak arról írunk, amit a boltod árul, és még nincs benne termék. Vegyél fel néhányat a Shopifyban, aztán gyere vissza.',
    action: 'Ugrás a Shopify termékeihez',
  },
  profile: {
    title: 'Erősítsd meg a boltprofilodat',
    subtitle: 'Ezt értettük meg a katalógusodból. Amíg nem erősíted meg, semmit sem írunk, és később a Beállításokban módosíthatod.',
    draft: 'Vázlat',
    sells: 'Mit árulsz',
    audience: 'Kik vásárolnak',
    language: 'A cikkek nyelve',
    languageUnsupported: 'Egyelőre angolul és magyarul írunk. Válaszd ki, melyiken készüljenek a cikkeid.',
    country: 'A vásárlóid országa',
    countryHint: 'Kétbetűs országkód, például HU vagy GB.',
    tone: 'Hangnem',
    tones: {
      plain: { label: 'Egyszerű', description: 'Világos és lényegre törő.' },
      friendly: { label: 'Barátságos', description: 'Közvetlen, mint egy törzsvásárlóval.' },
      expert: { label: 'Szakértői', description: 'Pontos, azoknak, akik értenek hozzá.' },
    },
    neverSay: 'Amit soha nem írhatunk',
    neverSayHint: 'Nem kötelező. Versenytársak nevei, állítások, amelyeket nem szeretnél, kerülendő szavak.',
    confirm: 'Megerősítem',
    saving: 'Mentés…',
    required: 'Ezt kérjük kitölteni.',
    unsupported: 'Válaszd az angolt vagy a magyart.',
  },
  languages: { en: 'Angol', hu: 'Magyar' },
  next: {
    title: 'A profil megerősítve',
    body: 'Következik: a Google Search Console csatlakoztatása, és annak kiválasztása, hogyan kerülnek a cikkek a boltodba.',
  },
}

export const MESSAGES = { en, hu }
export type Messages = typeof en

/** Shopify passes the admin user's locale to the embedded page, for example "hu-HU". */
export function uiLanguage(locale: string | null | undefined): UiLanguage {
  return locale?.toLowerCase().startsWith('hu') ? 'hu' : 'en'
}
