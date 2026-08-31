ALTER TABLE "workflows" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "workflows" SET "slug" = "id" WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_slug_idx" ON "workflows" ("slug");
