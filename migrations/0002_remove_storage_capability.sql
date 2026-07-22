-- Remove the retired browser Storage capability from current app rows. The
-- top-level key can appear in apps.manifest after a rollback copied a formerly
-- normalized manifest into that column, so clean both source and normalized
-- shapes without touching the app's on-disk STORAGE_DIR.
UPDATE "apps"
SET "capabilities" = "capabilities" - 'storage'
WHERE "capabilities" ? 'storage';
--> statement-breakpoint
UPDATE "apps"
SET "manifest" = ("manifest" #- '{capabilities,storage}') - 'storage'
WHERE "manifest" ? 'storage'
   OR "manifest" #> '{capabilities,storage}' IS NOT NULL;
--> statement-breakpoint
-- Historical deployments drive rollback, so scrub them as well; otherwise a
-- rollback could restore both the retired flag and its old HTTP API URL.
UPDATE "deployments"
SET "manifest_normalized" =
  ("manifest_normalized" #- '{capabilities,storage}') - 'storage'
WHERE "manifest_normalized" ? 'storage'
   OR "manifest_normalized" #> '{capabilities,storage}' IS NOT NULL;
