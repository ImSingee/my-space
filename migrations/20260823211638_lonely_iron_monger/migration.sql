CREATE TABLE "agent_session_apps" (
	"session_id" text,
	"app_id" text,
	CONSTRAINT "agent_session_apps_pkey" PRIMARY KEY("session_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_app_id_apps_id_fk";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "app_id";--> statement-breakpoint
CREATE INDEX "agent_session_apps_app_session_idx" ON "agent_session_apps" ("app_id","session_id");--> statement-breakpoint
ALTER TABLE "agent_session_apps" ADD CONSTRAINT "agent_session_apps_session_id_agent_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_session_apps" ADD CONSTRAINT "agent_session_apps_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;