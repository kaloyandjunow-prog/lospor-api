-- Token-revocation epoch: JWTs (web session or mobile bearer) issued before
-- this timestamp are rejected. Set on password reset so a reset actually
-- terminates existing sessions and mobile tokens.
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
