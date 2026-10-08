-- One file until the first paying store; the database is reset when it changes.
-- No column anywhere holds customer or order data: the GDPR answer depends on it.

create table stores (
  id bigint generated always as identity primary key,
  platform text not null default 'shopify' check (platform in ('shopify')),
  shop_domain text not null unique,
  access_token_enc text,
  access_token_expires_at timestamptz,
  refresh_token_enc text,
  refresh_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  storefront_host text,
  primary_locale text,
  country text,
  timezone text not null default 'UTC',
  delivery_mode text not null default 'export' check (delivery_mode in ('export', 'auto_publish')),
  publish_as text not null default 'live' check (publish_as in ('live', 'draft')),
  review_first boolean not null default false,
  target_blog_id text,
  publish_hour smallint not null default 9 check (publish_hour between 0 and 23),
  setup_step text not null default 'reading' check (setup_step in ('reading', 'no_products', 'profile', 'search_console', 'delivery', 'done')),
  catalog_synced_at timestamptz,
  installed_at timestamptz not null default now(),
  closed_at timestamptz,
  delete_after timestamptz
);

create table store_flags (
  store_id bigint primary key references stores(id) on delete cascade,
  paused_by_operator boolean not null default false,
  paused_by_merchant boolean not null default false,
  entitled boolean not null default true,
  budget_paused_on date,
  permissions_lost text[] not null default '{}',
  blog_missing boolean not null default false,
  gsc_disconnected boolean not null default false
);

create table gsc_connections (
  store_id bigint primary key references stores(id) on delete cascade,
  access_token_enc text,
  access_token_expires_at timestamptz,
  refresh_token_enc text,
  property text,
  connected_at timestamptz,
  disconnected_at timestamptz
);

create table products (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  platform_id text not null,
  handle text not null,
  title text not null,
  product_type text not null default '',
  vendor text not null default '',
  status text not null default 'active',
  options jsonb not null default '[]',
  tags text[] not null default '{}',
  images jsonb not null default '[]',
  collections jsonb not null default '[]',
  metafields jsonb not null default '[]',
  price_min numeric,
  price_max numeric,
  currency text,
  online_store_url text,
  -- Quarantined: read only by fact extraction, never by the writer.
  description_html text not null default '',
  content_hash text not null,
  facts_hash text,
  richness integer,
  last_seen_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (store_id, platform_id)
);

create table webhook_deliveries (
  delivery_id text primary key,
  store_id bigint references stores(id) on delete cascade,
  topic text not null,
  received_at timestamptz not null default now()
);

create table product_facts (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  product_id bigint not null references products(id) on delete cascade,
  fact text not null,
  source_field text not null,
  source_excerpt text not null,
  extracted_at timestamptz not null default now()
);
create index product_facts_product on product_facts(product_id);

create table store_pages (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  kind text not null check (kind in ('article', 'page', 'collection', 'blog')),
  platform_id text not null,
  handle text not null,
  url text not null,
  title text not null,
  excerpt text not null default '',
  ours boolean not null default false,
  last_seen_at timestamptz not null default now(),
  unique (store_id, kind, platform_id)
);

create table store_profile (
  store_id bigint primary key references stores(id) on delete cascade,
  sells text not null,
  audience text not null,
  language text not null check (language in ('en', 'hu')),
  country text not null,
  tone text not null default 'plain' check (tone in ('plain', 'friendly', 'expert')),
  never_say text not null default '',
  drafted_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table topics (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  canonical_key text not null,
  kind text not null default 'create' check (kind in ('create', 'refresh')),
  source text not null check (source in ('discovery', 'refresh', 'manual')),
  working_title text not null,
  target_query text not null,
  language text not null check (language in ('en', 'hu')),
  product_ids bigint[] not null default '{}',
  demand integer,
  -- The numbers that justified the topic, each with its source and date; the why line renders from this.
  evidence jsonb not null default '{}',
  rank double precision not null default 0,
  manual_order integer,
  state text not null default 'candidate' check (state in ('candidate', 'queued', 'scheduled', 'written', 'delivered', 'held', 'vetoed')),
  held_reason text,
  refresh_of_article_id bigint,
  scheduled_for date,
  created_at timestamptz not null default now(),
  unique (store_id, canonical_key)
);

create table not_interested (
  store_id bigint not null references stores(id) on delete cascade,
  canonical_key text not null,
  created_at timestamptz not null default now(),
  primary key (store_id, canonical_key)
);

create table articles (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  topic_id bigint not null unique references topics(id),
  language text not null,
  title text,
  meta_description text,
  slug text,
  markdown text,
  html text,
  product_ids bigint[] not null default '{}',
  claims jsonb not null default '[]',
  gate_report jsonb not null default '{}',
  state text not null default 'writing' check (state in ('writing', 'held', 'awaiting_review', 'ready', 'exported', 'published', 'draft_in_shopify', 'removed_by_merchant', 'discarded')),
  remote_id text,
  published_url text,
  last_sent_hash text,
  written_at timestamptz,
  approved_at timestamptz,
  delivered_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table topics add constraint topics_refresh_of foreign key (refresh_of_article_id) references articles(id);

create table publish_intents (
  id bigint generated always as identity primary key,
  store_id bigint not null references stores(id) on delete cascade,
  article_id bigint not null references articles(id) on delete cascade,
  operation text not null check (operation in ('create', 'update')),
  state text not null default 'pending' check (state in ('pending', 'executing', 'confirmed', 'remote_gone', 'failed')),
  body_hash text not null,
  remote_id text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one unfinished create per article: the database refuses a second one.
create unique index publish_intents_one_open_create on publish_intents(article_id)
  where operation = 'create' and state in ('pending', 'executing', 'confirmed');

create table article_metrics (
  article_id bigint not null references articles(id) on delete cascade,
  window_end date not null,
  clicks integer not null,
  impressions integer not null,
  position double precision,
  label text check (label in ('above', 'typical', 'below')),
  primary key (article_id, window_end)
);

create table gsc_daily (
  store_id bigint not null references stores(id) on delete cascade,
  date date not null,
  page text not null,
  query text not null,
  clicks integer not null,
  impressions integer not null,
  position double precision not null,
  primary key (store_id, date, page, query)
);

-- Written before the call is made, so a crash after the vendor answered never pays twice.
create table llm_calls (
  id bigint generated always as identity primary key,
  store_id bigint references stores(id) on delete set null,
  request_hash text not null,
  prompt_name text not null,
  prompt_version text not null,
  model text not null,
  request jsonb not null,
  response jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  estimated_cost_usd numeric not null,
  cost_usd numeric,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index llm_calls_done_once on llm_calls(request_hash) where status = 'done';
create index llm_calls_store_day on llm_calls(store_id, created_at);

create table vendor_calls (
  id bigint generated always as identity primary key,
  store_id bigint references stores(id) on delete set null,
  vendor text not null,
  endpoint text not null,
  request_hash text not null,
  request jsonb not null,
  response jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  estimated_cost_usd numeric not null,
  cost_usd numeric,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index vendor_calls_done_once on vendor_calls(request_hash) where status = 'done';
create index vendor_calls_store_day on vendor_calls(store_id, created_at);

-- No foreign key to stores: a completed key must outlive the store and every job row.
create table job_ledger (
  idempotency_key text primary key,
  store_id bigint,
  task text not null,
  output jsonb not null,
  completed_at timestamptz not null default now()
);

create table job_checkpoints (
  key text primary key,
  store_id bigint references stores(id) on delete cascade,
  cursor jsonb not null,
  updated_at timestamptz not null default now()
);
