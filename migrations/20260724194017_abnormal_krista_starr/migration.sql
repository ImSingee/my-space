ALTER TABLE "apps" ADD COLUMN "data_db_name" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "data_db_password_ciphertext" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "data_schema_hash" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "data_activation_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "data_schema_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "data_schema_hash" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "data_migration_summary" jsonb;