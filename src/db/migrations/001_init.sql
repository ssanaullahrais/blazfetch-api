-- Blazfetch initial schema
-- Stores only application/metadata state; never the downloaded media itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metadata_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT NOT NULL,
    media_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    metadata JSONB NOT NULL,
    thumbnail TEXT,
    formats JSONB,
    audio_formats JSONB,
    last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (platform, media_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_cache_canonical_url ON metadata_cache (canonical_url);
CREATE INDEX IF NOT EXISTS idx_metadata_cache_expires_at ON metadata_cache (expires_at);

CREATE TABLE IF NOT EXISTS fetch_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT NOT NULL,
    media_id TEXT,
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    guest_id TEXT,
    success BOOLEAN NOT NULL,
    extractor TEXT,
    fallback_used TEXT,
    duration_ms INTEGER,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fetch_stats_created_at ON fetch_stats (created_at);
CREATE INDEX IF NOT EXISTS idx_fetch_stats_platform ON fetch_stats (platform);

CREATE TABLE IF NOT EXISTS download_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID,
    platform TEXT NOT NULL,
    media_id TEXT,
    format TEXT,
    quality TEXT,
    kind TEXT CHECK (kind IN ('video', 'audio', 'image')),
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    guest_id TEXT,
    success BOOLEAN NOT NULL,
    bytes_transferred BIGINT,
    processing_duration_ms INTEGER,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_download_stats_created_at ON download_stats (created_at);

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'preparing', 'ready', 'streaming', 'completed', 'failed', 'cancelled', 'expired')),
    platform TEXT NOT NULL,
    media_id TEXT,
    canonical_url TEXT NOT NULL,
    requested_format JSONB NOT NULL,
    user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    guest_id TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes BIGINT NOT NULL DEFAULT 0,
    total_bytes BIGINT,
    filename TEXT,
    mime_type TEXT,
    error_code TEXT,
    error_message TEXT,
    temp_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_guest_id ON jobs (guest_id);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs (expires_at);
