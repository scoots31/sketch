-- Sketch persistence schema.
-- A sketch is a permanent place work lives: durable, reopenable, accumulating.
-- The document column holds the full tldraw store snapshot (JSON).
--
-- Built modular from day one: is_private (opt-out privacy), folder_id (folders
-- land later), and a name index (search later) are present now so the data model
-- can grow into organization without a migration rewrite.

CREATE TABLE IF NOT EXISTS sketches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT 'Untitled sketch',
  document    jsonb,                                   -- tldraw store snapshot
  is_private  boolean NOT NULL DEFAULT false,          -- opt-out privacy (agents skip private)
  owner_id    text NOT NULL DEFAULT 'scott',
  folder_id   uuid,                                    -- nullable; folders come later
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- list view: most-recently-touched first
CREATE INDEX IF NOT EXISTS sketches_updated_idx ON sketches (updated_at DESC);

-- name search, ready for when there are many
CREATE INDEX IF NOT EXISTS sketches_name_search_idx
  ON sketches USING gin (to_tsvector('english', name));
