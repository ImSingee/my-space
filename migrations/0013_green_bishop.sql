ALTER TABLE "apps" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "apps" SET "slug" = "id" WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_idx" ON "apps" USING btree ("slug");
