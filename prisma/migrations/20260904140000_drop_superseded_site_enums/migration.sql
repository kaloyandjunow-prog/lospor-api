-- Three single-value enums with no reader anywhere.
--
-- plexusBlock, cvkSite and arterialLineSite each recorded one site, and were
-- superseded by the `techniques` and `vascularAccesses` arrays, which allow
-- more than one and export properly. A traceability pass over all 186 clinical
-- columns found these three referenced by nothing: no control writes them, no
-- screen displays them, the OMOP mapper does not read them and relational-sync
-- does not mirror them. Their only remaining mention was three lines of Zod in
-- the web form's schema, with no field bound to them.
--
-- Dropped rather than commented, unlike volatileAgent and icdCode alongside
-- them. Those two are also superseded but are still *read* -- the printed
-- summary and the case-detail card display them for older records -- so
-- removing those columns would blank part of a record somebody can still open.
-- These three have no such reader, so nothing observable changes.
--
-- Any value already stored is discarded. That is the point: it was unreachable
-- from every screen and every export, so it was not doing the work a stored
-- clinical value is supposed to do.
ALTER TABLE "IntraoperativeRecord" DROP COLUMN "plexusBlock";
ALTER TABLE "IntraoperativeRecord" DROP COLUMN "cvkSite";
ALTER TABLE "IntraoperativeRecord" DROP COLUMN "arterialLineSite";

DROP TYPE "PlexusBlock";
DROP TYPE "CVKSite";
DROP TYPE "ArterialLineSite";
