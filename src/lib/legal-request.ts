import { z } from "zod"

export const legalAcceptanceReferenceSchema = z.object({
  deployment: z.string().min(1),
  kind: z.enum(["TERMS", "PRIVACY"]),
  version: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locale: z.enum(["bg", "en"]),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const legalAcceptancesSchema = z.array(legalAcceptanceReferenceSchema).length(2)
export const legalAcceptancesBodySchema = z.object({
  acceptances: legalAcceptancesSchema,
}).strict()
