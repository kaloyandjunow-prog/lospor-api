/**
 * The clinical-rules service's own error, carrying the HTTP status the route
 * should answer with. Its own module so the authorization helpers can throw it
 * without importing the service they are called from.
 */
export class ClinicalRuleServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = "ClinicalRuleServiceError"
  }
}
