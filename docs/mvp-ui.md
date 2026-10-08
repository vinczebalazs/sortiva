# Sortiva MVP — the user interface

Written 2026-10-08. Companion to `docs/mvp-plan.md`. Audience: the founders. This describes every screen a merchant sees, what each word on it means, and what happens when they act. It is a description of behaviour, not of components. Open decisions are marked **U1** to **U5** and collected at the end.

---

## 1. Where the app lives

The app runs **inside the Shopify admin**, under Apps. It looks like a Shopify page: Shopify's own design language, Shopify's navigation on the left, our screens in the middle. There is no separate website to sign in to, no password, no email login. Opening the app in the admin is the sign-in.

The one thing that leaves the admin is Google's consent screen for Search Console, which opens in its own window because Google refuses to load inside another site's frame. It closes itself when done.

Nothing in the MVP sends email. Everything the merchant needs to know is on screen when they open the app.

### 1.1 Visual reference

There is a set of reference mockups that define **the look**: colour, spacing, typography, how dense or calm a screen feels, the tone of the copy. They are the design system. They are not a specification of screens or behaviour; where a mockup and this document disagree on what a screen contains or does, this document wins.

- Project: `https://claude.ai/design/p/69b8c04d-7bdf-495a-9758-746b102d12f8?file=Sortiva+UI+Mockups.dc.html`
- Read it through the `claude_design` MCP (`https://api.anthropic.com/v1/design/mcp`, authenticated with `/design-login`). The file to read is `Sortiva UI Mockups.dc.html`; it imports `support.js`, read that too.

**Our own components, not Shopify's.** Embedded means the pages load inside a frame in the Shopify admin and use App Bridge for the session token, the title bar and the navigation entries. It does not require Shopify's component library; that is only a condition of the optional "Built for Shopify" badge. So the screen layer is split in two:

- **Our screens**, one React design system built from the mockups, hosted anywhere. They know nothing about the platform and talk to our API with a bearer token.
- **A host shell per platform.** Shopify: App Bridge, session token exchanged for our token, navigation entries in the admin. WordPress later: a plugin menu page rendering the same screens, with WordPress's own login as identity. Standalone later: our own sign-in. The shell is the only front-end code that changes per platform; the connector is the only back-end code that does.

The screens are tested once in the Shopify mobile app, where embedded apps also render.

---

## 2. Vocabulary

Every screen uses these words and only these.

| Word | Meaning for the merchant |
|---|---|
| **Topic** | One thing we plan to write about. A topic has a working title, the search phrase it targets, how many people search for that phrase each month, and the products from the store it would mention. |
| **Queue** | The ordered list of topics we intend to write, one per day. The top one is next. |
| **Article** | A finished piece of writing produced from a topic. An article is either waiting for the merchant, exported, published, or held. |
| **Held** | We wrote an article but it did not pass our checks, so it will not go out. The reason is shown. |
| **Export** | We hand the article over as files for the merchant to publish themselves. |
| **Auto-publish** | We post the article to the store's blog at the publish hour. |
| **Draft in Shopify** | A variant of auto-publish: we create the article in Shopify as hidden, so the merchant publishes it from the Shopify admin. |
| **Review first** | A setting: every article waits for the merchant's approval before it goes out, in either mode. |
| **Limited** | Search Console is not connected. We still write, but we cannot measure results or spot articles worth refreshing. |
| **Paused** | Nothing is being written or sent. Either the merchant paused it, or we paused it and say why. |

The words "opportunity", "signal", "calendar", "persona", "gate" and "evidence pack" do not appear anywhere in the interface.

---

## 3. Navigation

Four items, in the app's left-hand list:

1. **Home** — today, the queue, and anything that needs attention.
2. **Articles** — everything written, with results.
3. **Products** — what we can and cannot write about.
4. **Settings** — store profile, publishing, Search Console, pause.

A first-time merchant sees none of these until setup is complete; they see the setup flow instead.

---

## 4. Setup (first open after install)

A single flow of four steps, each its own screen, with a progress indicator. The merchant can close the admin and come back; the flow resumes where it was.

**Step 1 — Reading your store.** A progress screen. Three lines with ticks as they complete: "Reading products (N of M)", "Understanding each product", "Drafting your store profile". This runs in the background; the screen updates itself. If the store has no products, the flow stops here with "Add products to your store first" and a link to Shopify's product page.

**Step 2 — Confirm your store profile.** One screen, editable fields:

- What you sell (two or three sentences we drafted).
- Who buys it (one or two sentences).
- Language of your articles (pre-filled from the store's primary language, **English or Hungarian** only; a store in any other language sees "We write in English and Hungarian for now" and picks one).
- Country of your customers (pre-filled from the store's country).
- Tone: three choices, plain / friendly / expert.
- Things we must never say (free text, optional): competitor names, claims the merchant does not want.

A "Confirm" button. Nothing is written before this is pressed. The profile can be changed later in Settings.

**Step 3 — Connect Google Search Console (optional).** One paragraph explaining what it gives: "With Search Console we can show which articles bring visitors and improve the ones that nearly rank. Without it we still write, but cannot measure." Two buttons: "Connect" (opens Google's window; on return, a list of the merchant's properties with the one matching the store pre-selected; "Use this property") and "Skip for now". Skipping sets Limited mode, shown as a small badge on Home, and can be undone in Settings.

**Step 4 — How articles reach your store.** Two large options: **Export** (default, selected) and **Auto-publish**. Choosing auto-publish reveals: a blog picker (the store's blogs, with "Create a blog called 'Blog'" if there are none), "Publish live" versus "Draft in Shopify", and a publish hour (default 9:00 in the store's timezone). Below both options, one checkbox: "Review every article before it goes out" (default on for auto-publish, off for export). "Finish setup".

Then: a short screen "Finding topics…" that becomes Home when the first queue exists. If the store is too thin for even one topic, Home opens in its thin-store state (§5.4).

---

## 5. Home

### 5.1 Today

A card at the top. One of these states:

- **Nothing scheduled today** — the queue is empty or paused. Says why in one line.
- **Scheduled: *title*** — writing starts at the publish hour. "Skip this one" removes it from the queue.
- **Writing…** — in progress. No action.
- **Waiting for your review: *title*** — with "Review" leading to the article (§7).
- **Ready to export: *title*** — with "Download".
- **Published: *title*** — with "View in your store" and, in auto-publish draft mode, "Open in Shopify".
- **Held: *title*** — with the reason in one plain sentence ("Two of its claims could not be backed by your product details") and "See details".

### 5.2 Up next

The queue as a list, in order. Each row shows:

- Working title.
- The search phrase and monthly searches (a number, no target, no "x of y").
- The products it would mention, as small thumbnails with names (at most four, then "+N").
- A **why line**, one sentence generated from the numbers, for example "About 1,900 people a month search for this and your store has no page about it" or "Your article on this ranks 11th; a refresh could move it to page one".
- An expected date, computed from its position (position 3 means three days from now, skipping paused days). This is the whole content calendar. There is no month grid (**U1**).
- Actions: **Not interested** (removes it for good; we will not propose it again) and **Move to top**.

Topics that are refreshes of an existing article are marked "Refresh" and link to that article.

### 5.3 Add a topic

A text field at the bottom of the queue: "Something you want an article about". On submit we run the same checks as our own topics. Three outcomes, shown inline: added to the queue with its why line; "You already have a page about this: *page title*", with a link; or "We cannot back this with your product details" with the products we would need facts for. A manual topic goes to the top of the queue.

### 5.4 Thin-store state

When the store has fewer than the floor of products with usable details, Home shows, instead of or above the queue: "We can write about N of your M products. The others need fuller descriptions." with a link to Products (§8). If N is zero, the queue section is replaced by that message entirely.

### 5.5 Banners

Shown at the top of every screen while the condition holds, each with one sentence and, where there is one, one action:

- **Paused by you** — "Resume".
- **Paused: daily budget reached** — resumes tomorrow by itself.
- **Paused: we lost permission to *read products / write to your blog*** — "Reinstall" or "Grant".
- **Auto-publish is on but no blog is chosen** — "Choose a blog".
- **Search Console disconnected** — "Reconnect".
- **Limited: Search Console not connected** — small badge, not a banner, with "Connect" (**U2**: badge versus banner).

---

## 6. Articles

A table, newest first. Columns:

- Title (links to the article).
- Date written.
- Status: Waiting for review / Exported / Published / Draft in Shopify / Held / Removed by you (merchant deleted it in Shopify).
- Results, only when Search Console is connected and the article has a known URL: clicks and impressions in the last 28 days, and after day 28 a label: **Above your average**, **Typical**, **Below your average**. Before day 28: "Too new to judge". In Limited mode the column is absent and a note under the table says why.

Filters: status. No search box in the MVP.

For exported articles whose URL we do not know, the row shows "Where did you publish it?" with a field to paste the URL. Until it is pasted, that article cannot have results.

---

## 7. Article

The page for one article. Three areas.

**Preview.** The article rendered as it would appear: headings, paragraphs, lists, links, and the product cards with the chosen image, name and a link to the product. This is the real rendered HTML, the same bytes we would send to Shopify, in a plain frame. A toggle shows the Markdown. There is no editor (**U3**).

**What it is built on.** A side panel:

- The topic: search phrase, monthly searches, the why line.
- Products mentioned, each linking to its Shopify product page.
- Facts used: a list of the product facts the article relies on, each with the product it came from. Every claim in the article is one of these; nothing else is asserted about a product.
- Checks: a short list with ticks, "Every product claim backed by a fact", "No outside links", "Language: Hungarian", "Quality review passed" with the reviewer's scores shown as five small bars. For a held article the failed check is shown first, in red, with the sentence that caused it.

**Actions**, by status:

- Waiting for review: **Approve** (goes out at the next publish hour, or immediately if the hour has passed today) and **Discard** (the topic is marked not interested).
- Exported: **Download** (a zip with the Markdown, the HTML and a metadata file) and the "Where did you publish it?" field.
- Published / Draft in Shopify: **View in your store**, **Open in Shopify**. If a product in it has since been removed from the store, a note: "We removed the card for *product*, which is no longer in your store" with the date.
- Held: no retry button. The topic goes back to the queue only if the merchant adds the missing product details and uses "Add a topic" again, or if we re-discover it later with better facts.

Results, when available: a small chart of daily clicks and impressions since publication, the average position, and the label with one sentence of explanation ("Your articles get a median of 40 clicks in their first 28 days; this one got 95").

---

## 8. Products

A read-only table of the store's products: thumbnail, name, product type, and one column, **Can we write about it?**: "Yes (N facts)" or "Needs a fuller description". Sorted so the "needs" rows come first. A sentence at the top: "We only say things about your products that your product details support. Products with short or purely promotional descriptions give us nothing to say." A link to the product in Shopify on each row.

Above the table: **"Last synced: *time*"** and a **"Sync now"** button. Pressing it re-reads the whole catalogue from Shopify; the button shows "Syncing… (N of M)" and is disabled until the run finishes, and only one sync runs per store at a time. Products whose details changed get their facts re-extracted; the others are untouched.

Nothing is edited here. The store's own product page is the editor. How the table stays current without the button:

- **Shopify tells us within seconds** when a product or collection is created, changed or deleted (webhooks). We treat each as "re-read this product from Shopify now", never as the truth itself, because deliveries can repeat or arrive out of order. A burst of changes, such as a bulk edit, is collapsed into one catalogue re-read.
- **Every night we re-read everything** and compare, which catches anything a webhook missed.
- **Facts are only re-extracted when the title, description, options or tags changed.** A price or image change updates the row without a model call.

---

## 9. Settings

Four sections on one page, each saving on its own.

**Store profile.** The same fields as setup step 2, editable. Changing the language takes effect for topics not yet written; written articles keep their language.

**Publishing.** The same choices as setup step 4: Export / Auto-publish; blog; live or draft; publish hour; review first. Switching from auto-publish to export does not touch anything already published. Switching on auto-publish without a blog is refused inline until one is chosen.

**Search Console.** Status: connected to *property* since *date*, or not connected. "Connect" / "Disconnect" / "Change property".

**Pause.** One switch: "Pause Sortiva". Paused means no writing and no sending; the queue stays as it is. A line under it says what is currently paused by us, if anything, and why.

There is no billing section in the MVP. Entitlement during the pilot is set by hand on our side; a store that is not entitled sees a banner "Sortiva is not active for this store" and nothing else changes.

**Uninstall** is Shopify's own button, not ours. On uninstall we stop everything and delete the store's data after 30 days; nothing is shown because the app is gone.

---

## 10. What is deliberately not in the interface

- A month calendar with drag and drop. The queue with expected dates replaces it (**U1**).
- An opportunities screen, scores, confidence, signal names.
- An article editor. Shopify is the editor after publishing; before publishing the choice is approve or discard (**U3**).
- Notifications, a bell, digests, emails.
- A performance dashboard separate from the Articles table (**U4**).
- Competitors, keywords lists, product families.
- Any count with a denominator ("3 of 30 this month").
- Anything that says we will publish a given number of articles.

---

## 11. Decisions for the founders

**U1 — Queue list with expected dates, instead of a calendar grid.** *What the old build had:* a month and week calendar with veto, drag to move, pin, add. Eight components and a large share of the content-screen bugs. *What I propose:* the ordered list, with the date each item would be written shown on the row, "Move to top" and "Not interested" as the only operations. *What it loses:* choosing a specific day for a specific topic. *Recommendation:* the list. A merchant who cares about a date can move the topic to the top on that day.

**U2 — Limited mode as a small badge on Home, not a banner on every screen.** Banners are for things that stop work; limited mode does not stop writing. *Recommendation:* badge.

**U3 — No editor, not even for the title.** *What it costs:* a merchant who dislikes one sentence must discard the whole article or edit it in Shopify after publishing. *Why:* an in-app edit would be an uncited change to a checked article; after publishing, Shopify's editor is the right place and we never overwrite edits (rule 6). *Recommendation:* no editor. The "things we must never say" field in the profile is the lever for recurring complaints.

**U4 — Results live in the Articles table and the Article page, with no separate Performance screen.** A store-level chart (total clicks from our articles over time) is one card and could sit at the top of Articles. *Recommendation:* add that one card to Articles and nothing more.

**U5 — Review-first default.** *Proposal:* on by default when auto-publish is chosen, off for export. *Alternative:* always on for the first N articles, then the merchant's choice. *Recommendation:* the proposal; the first pilot store will have it on either way because you will be reading everything.
