CREATE TABLE "app_access_codes" (
	"digest" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"session_id" text NOT NULL,
	"revision" text NOT NULL,
	"origin" text NOT NULL,
	"challenge" text NOT NULL,
	"return_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_tailscale_services" (
	"app_id" text PRIMARY KEY,
	"service_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_access_codes_expiry_idx" ON "app_access_codes" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_tailscale_services_name_idx" ON "app_tailscale_services" ("service_name");--> statement-breakpoint
ALTER TABLE "app_access_codes" ADD CONSTRAINT "app_access_codes_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_access_codes" ADD CONSTRAINT "app_access_codes_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app_tailscale_services" ADD CONSTRAINT "app_tailscale_services_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;