import { Knex } from 'knex';
import { getKnex } from './knexClient';

/**
 * Creates the schema via Knex's schema builder rather than raw SQL, so the exact same code
 * works across Postgres, MySQL, and SQLite without per-dialect branching. IDs are
 * application-generated UUID strings (not DB-native gen_random_uuid()/AUTO_INCREMENT) so the
 * same value works identically on every driver, including SQLite which has no UUID type.
 */
async function baselineSchema(knex: Knex): Promise<void> {

  if (!(await knex.schema.hasTable('metadata_cache'))) {
    await knex.schema.createTable('metadata_cache', (t: Knex.CreateTableBuilder) => {
      t.string('id', 36).primary();
      t.string('platform', 64).notNullable();
      t.string('media_id', 255).notNullable();
      t.text('canonical_url').notNullable();
      t.json('metadata').notNullable();
      t.text('thumbnail');
      t.json('formats');
      t.json('audio_formats');
      t.timestamp('last_fetched_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at').notNullable();
      t.unique(['platform', 'media_id']);
      t.index(['expires_at']);
    });
    // MySQL can't index a TEXT column without a prefix length; other drivers index it whole.
    if (knex.client.config.client === 'mysql2') {
      await knex.raw('create index metadata_cache_canonical_url_index on metadata_cache (canonical_url(255))');
    } else {
      await knex.schema.alterTable('metadata_cache', (t: Knex.AlterTableBuilder) => t.index(['canonical_url']));
    }
  }

  if (!(await knex.schema.hasTable('jobs'))) {
    await knex.schema.createTable('jobs', (t: Knex.CreateTableBuilder) => {
      t.string('id', 36).primary();
      t.string('status', 32).notNullable().defaultTo('queued');
      t.string('platform', 64).notNullable();
      t.string('media_id', 255);
      t.text('canonical_url').notNullable();
      t.json('requested_format').notNullable();
      t.string('user_id', 36);
      t.string('guest_id', 255);
      t.integer('progress').notNullable().defaultTo(0);
      t.bigInteger('downloaded_bytes').notNullable().defaultTo(0);
      t.bigInteger('total_bytes');
      t.string('filename', 512);
      t.string('mime_type', 128);
      t.string('error_code', 64);
      t.text('error_message');
      t.text('temp_path');
      t.text('source_url');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at');
      t.index(['status']);
      t.index(['user_id']);
      t.index(['guest_id']);
    });
  }

  if (!(await knex.schema.hasTable('fetch_stats'))) {
    await knex.schema.createTable('fetch_stats', (t: Knex.CreateTableBuilder) => {
      t.string('id', 36).primary();
      t.string('platform', 64).notNullable();
      t.string('media_id', 255);
      t.string('user_id', 36);
      t.string('guest_id', 255);
      t.boolean('success').notNullable();
      t.string('extractor', 128);
      t.string('fallback_used', 128);
      t.integer('duration_ms');
      t.string('error_code', 64);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['created_at']);
      t.index(['platform']);
    });
  }

  if (!(await knex.schema.hasTable('download_stats'))) {
    await knex.schema.createTable('download_stats', (t: Knex.CreateTableBuilder) => {
      t.string('id', 36).primary();
      t.string('job_id', 36);
      t.string('platform', 64).notNullable();
      t.string('media_id', 255);
      t.string('format', 128);
      t.string('quality', 64);
      t.string('kind', 16);
      t.string('user_id', 36);
      t.string('guest_id', 255);
      t.boolean('success').notNullable();
      t.bigInteger('bytes_transferred');
      t.integer('processing_duration_ms');
      t.string('error_code', 64);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['created_at']);
    });
  }
}

async function addColumns(knex: Knex, table: string, columns: Record<string, (t: Knex.AlterTableBuilder) => void>): Promise<void> {
  for (const [name, add] of Object.entries(columns)) {
    if (!(await knex.schema.hasColumn(table, name))) {
      await knex.schema.alterTable(table, (t) => add(t));
    }
  }
}

/**
 * v2: metadata_cache becomes the permanent media store. Rows are keyed as before (platform, media_id);
 * a playlist uses media_id = "playlist:<id>", so no unique index has to change. Timestamp columns are
 * nullable with no default because SQLite cannot add a column with a non-constant default.
 */
async function mediaStore(knex: Knex): Promise<void> {
  await addColumns(knex, 'metadata_cache', {
    kind: (t) => t.string('kind', 16).notNullable().defaultTo('video'),
    source_url: (t) => t.text('source_url'),
    path: (t) => t.string('path', 512),
    title: (t) => t.text('title'),
    author_name: (t) => t.string('author_name', 255),
    duration_seconds: (t) => t.integer('duration_seconds'),
    extractor: (t) => t.string('extractor', 128),
    status: (t) => t.string('status', 16).notNullable().defaultTo('available'),
    unavailable_reason: (t) => t.string('unavailable_reason', 64),
    unavailable_since: (t) => t.timestamp('unavailable_since'),
    is_public: (t) => t.boolean('is_public').notNullable().defaultTo(true),
    check_fail_count: (t) => t.integer('check_fail_count').notNullable().defaultTo(0),
    first_fetched_at: (t) => t.timestamp('first_fetched_at'),
    validated_at: (t) => t.timestamp('validated_at'),
    last_check_at: (t) => t.timestamp('last_check_at'),
    next_check_at: (t) => t.timestamp('next_check_at'),
    fetch_count: (t) => t.integer('fetch_count').notNullable().defaultTo(0),
    hit_count: (t) => t.integer('hit_count').notNullable().defaultTo(0),
    view_count: (t) => t.integer('view_count').notNullable().defaultTo(0),
    download_count: (t) => t.integer('download_count').notNullable().defaultTo(0),
    stream_count: (t) => t.integer('stream_count').notNullable().defaultTo(0),
    prepare_count: (t) => t.integer('prepare_count').notNullable().defaultTo(0),
    bytes_served: (t) => t.bigInteger('bytes_served').notNullable().defaultTo(0),
    last_accessed_at: (t) => t.timestamp('last_accessed_at'),
    last_downloaded_at: (t) => t.timestamp('last_downloaded_at'),
  });

  await knex.schema.alterTable('metadata_cache', (t) => {
    t.index(['next_check_at'], 'metadata_cache_next_check_at_index');
    t.index(['platform', 'kind'], 'metadata_cache_platform_kind_index');
  });

  // Rows saved before this version: treat the last fetch as their first fetch and validation, and
  // spread their first re-check over the coming week so they are not all checked at once.
  await knex('metadata_cache').whereNull('first_fetched_at').update({
    first_fetched_at: knex.ref('last_fetched_at'),
    validated_at: knex.ref('last_fetched_at'),
    source_url: knex.ref('canonical_url'),
    next_check_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

/** v3: richer per-event statistics. */
async function eventStats(knex: Knex): Promise<void> {
  await addColumns(knex, 'fetch_stats', {
    cache_hit: (t) => t.boolean('cache_hit'),
    cache_stale: (t) => t.boolean('cache_stale'),
    kind: (t) => t.string('kind', 16),
    source: (t) => t.string('source', 16),
  });
  await addColumns(knex, 'download_stats', {
    mode: (t) => t.string('mode', 16),
    first_byte_ms: (t) => t.integer('first_byte_ms'),
    fell_back: (t) => t.boolean('fell_back'),
  });
}

/** v4: presence for the public "online now" counter. One row per visitor (their guest id, or user id when
 * signed in); recordPresence upserts last_seen_at, totals() counts rows newer than the configured window. */
async function visitorPresence(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('visitor_presence'))) {
    await knex.schema.createTable('visitor_presence', (t: Knex.CreateTableBuilder) => {
      t.string('visitor_id', 255).primary();
      t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
      t.index(['last_seen_at']);
    });
  }
}

interface Migration {
  version: number;
  name: string;
  up: (knex: Knex) => Promise<void>;
}

/** Append new migrations to the end; never edit or reorder ones that have shipped. */
const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline schema', up: baselineSchema },
  { version: 2, name: 'permanent media store', up: mediaStore },
  { version: 3, name: 'richer event statistics', up: eventStats },
  { version: 4, name: 'visitor presence', up: visitorPresence },
];

/** Applies every migration that has not run yet, in order, and records it. Safe to run repeatedly. */
export async function runSqlMigrations(): Promise<void> {
  const knex = getKnex();

  if (!(await knex.schema.hasTable('schema_migrations'))) {
    await knex.schema.createTable('schema_migrations', (t: Knex.CreateTableBuilder) => {
      t.integer('version').primary();
      t.string('name', 128).notNullable();
      t.timestamp('applied_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  const applied = new Set((await knex('schema_migrations').select('version')).map((r: { version: number }) => Number(r.version)));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await migration.up(knex);
    await knex('schema_migrations').insert({ version: migration.version, name: migration.name });
  }
}
