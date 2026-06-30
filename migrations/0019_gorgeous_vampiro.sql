DROP INDEX "sidebar_items_app_idx";--> statement-breakpoint
CREATE INDEX "sidebar_items_app_idx" ON "sidebar_items" USING btree ("app_id");