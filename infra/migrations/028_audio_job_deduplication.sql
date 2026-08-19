-- Keep exactly one durable audio job for each message/media pair.
-- Older connector versions could create several rows when the same media event
-- was delivered through more than one user connection or was redelivered by
-- JetStream. Prefer the most useful existing result before enforcing the key.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY message_id, media_key
      ORDER BY
        CASE status
          WHEN 'completed' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'failed' THEN 3
          ELSE 4
        END,
        (object_path IS NOT NULL) DESC,
        (transcript IS NOT NULL) DESC,
        updated_at DESC,
        created_at DESC,
        id
    ) AS duplicate_rank
  FROM audio_jobs
)
DELETE FROM audio_jobs aj
USING ranked
WHERE aj.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audio_jobs_message_media
  ON audio_jobs (message_id, media_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON audio_jobs TO wagi_app;
