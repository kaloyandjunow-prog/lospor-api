import "server-only"

type EmailRecipient = { email: string; name?: string | null }

type SendEmailInput = {
  to: EmailRecipient
  subject: string
  html: string
  text: string
}

export type SendEmailResult =
  | { sent: true; provider: "brevo"; messageId?: string }
  | { sent: false; provider: "none"; reason: string }

function appBaseUrl(): string {
  return process.env.LOSPOR_WEB_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? process.env.NEXTAUTH_URL
    ?? "http://localhost:3000"
}

export function appUrl(path: string): string {
  return new URL(path, appBaseUrl()).toString()
}

function sender() {
  return {
    email: process.env.AUTH_EMAIL_FROM ?? "no-reply@lospor.org",
    name: process.env.AUTH_EMAIL_FROM_NAME ?? "LOSPOR",
  }
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) {
    console.warn(`[email] BREVO_API_KEY missing; skipped "${input.subject}" to ${input.to.email}`)
    return { sent: false, provider: "none", reason: "BREVO_API_KEY missing" }
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: sender(),
      to: [{ email: input.to.email, name: input.to.name ?? undefined }],
      subject: input.subject,
      htmlContent: input.html,
      textContent: input.text,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Brevo email failed ${response.status}: ${body.slice(0, 500)}`)
  }

  const body = await response.json().catch(() => ({})) as { messageId?: string }
  return { sent: true, provider: "brevo", messageId: body.messageId }
}

export async function sendVerificationEmail(to: EmailRecipient, verifyUrl: string): Promise<SendEmailResult> {
  return sendTransactionalEmail({
    to,
    subject: "Verify your LOSPOR email",
    text: `Open this link to verify your LOSPOR account email:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <p>Hello,</p>
      <p>Open this link to verify your LOSPOR account email:</p>
      <p><a href="${verifyUrl}">Verify email</a></p>
      <p>This link expires in 24 hours.</p>
    `,
  })
}

export async function sendPasswordResetEmail(to: EmailRecipient, resetUrl: string): Promise<SendEmailResult> {
  return sendTransactionalEmail({
    to,
    subject: "Reset your LOSPOR password",
    text: `Open this link to reset your LOSPOR password:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    html: `
      <p>Hello,</p>
      <p>Open this link to reset your LOSPOR password:</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>This link expires in 1 hour. If you did not request this, ignore this email.</p>
    `,
  })
}
