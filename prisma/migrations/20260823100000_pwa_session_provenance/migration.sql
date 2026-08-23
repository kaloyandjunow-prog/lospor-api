-- Bind PWA event provenance to the server-issued authentication session.
-- PWA uses the cookie transport like Web, but is the mobile clinical client
-- and must remain distinguishable in audit/event provenance and device lists.
ALTER TYPE "AuthSessionClientType" ADD VALUE 'PWA';
