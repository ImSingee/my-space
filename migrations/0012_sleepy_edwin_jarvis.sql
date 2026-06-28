-- Deduplicate any pre-existing rows that violate the new uniqueness before
-- creating the indexes, so installs where the (now-fixed) deploy race already
-- produced duplicates can still migrate. For deployment tables the survivor is
-- the row the parent currently references (it holds the live build/source
-- metadata that manifest/artifact/log/rollback paths read), falling back to the
-- earliest id; this keeps current_deployment_id valid without a remap.
DELETE FROM "deployments" d WHERE EXISTS (SELECT 1 FROM "deployments" o WHERE o."app_id" = d."app_id" AND o."version" = d."version" AND o."id" <> d."id") AND d."id" <> COALESCE((SELECT g."id" FROM "deployments" g JOIN "apps" ap ON ap."id" = g."app_id" WHERE g."app_id" = d."app_id" AND g."version" = d."version" AND ap."current_deployment_id" = g."id" LIMIT 1), (SELECT MIN(g."id") FROM "deployments" g WHERE g."app_id" = d."app_id" AND g."version" = d."version"));--> statement-breakpoint
DELETE FROM "workflow_deployments" d WHERE EXISTS (SELECT 1 FROM "workflow_deployments" o WHERE o."workflow_id" = d."workflow_id" AND o."version" = d."version" AND o."id" <> d."id") AND d."id" <> COALESCE((SELECT g."id" FROM "workflow_deployments" g JOIN "workflows" wf ON wf."id" = g."workflow_id" WHERE g."workflow_id" = d."workflow_id" AND g."version" = d."version" AND wf."current_deployment_id" = g."id" LIMIT 1), (SELECT MIN(g."id") FROM "workflow_deployments" g WHERE g."workflow_id" = d."workflow_id" AND g."version" = d."version"));--> statement-breakpoint
DELETE FROM "sidebar_items" a USING "sidebar_items" b WHERE a."app_id" = b."app_id" AND a."id" > b."id";--> statement-breakpoint
DELETE FROM "dashboard_widgets" a USING "dashboard_widgets" b WHERE a."dashboard_id" = b."dashboard_id" AND a."app_id" = b."app_id" AND a."widget_id" = b."widget_id" AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_widgets_dash_app_widget_idx" ON "dashboard_widgets" USING btree ("dashboard_id","app_id","widget_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_app_version_idx" ON "deployments" USING btree ("app_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sidebar_items_app_idx" ON "sidebar_items" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_deployments_workflow_version_idx" ON "workflow_deployments" USING btree ("workflow_id","version");
