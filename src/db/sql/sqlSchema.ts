import { Knex } from 'knex';
import { getKnex } from './knexClient';

/**
 * Creates the schema via Knex's schema builder rather than raw SQL, so the exact same code
 * works across Postgres, MySQL, and SQLite without per-dialect branching. IDs are
 * application-generated UUID strings (not DB-native gen_random_uuid()/AUTO_INCREMENT) so the
 * same value works identically on every driver, including SQLite which has no UUID type.
 */
export async function runSqlMigrations(): Promise<void> {
  const knex = getKnex();

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
