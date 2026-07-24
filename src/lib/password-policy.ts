import { z } from "zod"
import {
  passwordPolicyIssues,
  type PasswordPolicyIssue,
} from "@lospor/core/account"

const MESSAGES: Record<PasswordPolicyIssue, string> = {
  too_short: "At least 8 characters",
  missing_uppercase: "At least one uppercase letter",
  missing_number: "At least one number",
  missing_special: "At least one special character",
}

export const passwordSchema = z.string().superRefine((password, context) => {
  for (const issue of passwordPolicyIssues(password)) {
    context.addIssue({ code: "custom", message: MESSAGES[issue] })
  }
})
