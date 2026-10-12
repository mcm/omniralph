CREATE TABLE "hidden_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hidden_refs" ADD CONSTRAINT "hidden_refs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hidden_refs" ADD CONSTRAINT "hidden_refs_run_id_ralph_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hidden_refs_repository_ref_uq" ON "hidden_refs" USING btree ("repository_id","ref");--> statement-breakpoint
CREATE INDEX "hidden_refs_run_idx" ON "hidden_refs" USING btree ("run_id");