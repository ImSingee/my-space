ALTER TABLE "deployments" RENAME COLUMN "subapp_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" RENAME COLUMN "subapp_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "sidebar_items" RENAME COLUMN "subapp_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "agent_sessions" RENAME COLUMN "subapp_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "logs" RENAME COLUMN "subapp_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "subapps" RENAME TO "apps";--> statement-breakpoint
ALTER TABLE "apps" RENAME CONSTRAINT "subapps_pkey" TO "apps_pkey";--> statement-breakpoint
ALTER TABLE "deployments" RENAME CONSTRAINT "deployments_subapp_id_subapps_id_fk" TO "deployments_app_id_apps_id_fk";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" RENAME CONSTRAINT "dashboard_widgets_subapp_id_subapps_id_fk" TO "dashboard_widgets_app_id_apps_id_fk";--> statement-breakpoint
ALTER TABLE "sidebar_items" RENAME CONSTRAINT "sidebar_items_subapp_id_subapps_id_fk" TO "sidebar_items_app_id_apps_id_fk";--> statement-breakpoint
ALTER TABLE "agent_sessions" RENAME CONSTRAINT "agent_sessions_subapp_id_subapps_id_fk" TO "agent_sessions_app_id_apps_id_fk";
