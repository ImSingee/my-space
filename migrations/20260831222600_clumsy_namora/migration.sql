ALTER TABLE "workflow_deployments" ADD COLUMN "compatibility_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_deployments" ALTER COLUMN "compatibility_version" DROP DEFAULT;
