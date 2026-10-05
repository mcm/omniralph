# accounts-api

Migrations in `migrations/` run in order during deploy, before the new
version of the API starts taking traffic (the old version keeps serving until
then).
