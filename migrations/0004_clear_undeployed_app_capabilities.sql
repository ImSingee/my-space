UPDATE "apps"
SET
	"capabilities" = NULL,
	"manifest" = NULL,
	"backend_mode" = NULL
WHERE
	"current_deployment_id" IS NULL
	AND (
		"capabilities" IS NOT NULL
		OR "manifest" IS NOT NULL
		OR "backend_mode" IS NOT NULL
	);
