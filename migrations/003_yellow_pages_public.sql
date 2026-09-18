-- Public Yellow Pages is shared across all Rowe users (owner_id = 'public').
INSERT INTO users (id, email, name, session_count)
VALUES ('public', NULL, 'Rowe Public', 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE yellow_pages_directories
  DROP CONSTRAINT IF EXISTS yellow_pages_directories_owner_id_fkey;

ALTER TABLE yellow_pages_directories
  ADD CONSTRAINT yellow_pages_directories_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
