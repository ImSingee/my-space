ALTER TABLE "apps" ADD COLUMN "repo_path" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "current_source_commit" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_commit" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_tag" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_path" text;