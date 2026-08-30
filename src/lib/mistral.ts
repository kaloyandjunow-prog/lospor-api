const GLOBAL_MISTRAL_API_BASE = "https://api.mistral.ai/v1"
// Clinical payloads default to EU inference. An unconfigured deployment must
// not reach the global endpoint by omission: residency is decided by this
// value, not by the fallback flag below, which cannot even engage while the
// configured base already is the global one.
const DEFAULT_MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
const CHAT_COMPLETIONS_PATH = "/chat/completions"

type MistralFetchOptions = {
  signal?: AbortSignal
}

function configuredMistralBase() {
  return (process.env.MISTRAL_API_BASE ?? DEFAULT_MISTRAL_API_BASE).replace(/\/$/, "")
}

// A regional endpoint refusing inference must not silently move the same
// clinical payload to the global one. The retry is an exceptional transfer and
// stays off unless it has been explicitly approved for this deployment.
//
// This guard already existed in the Hospital appliance's vendored copy of this
// file, defaulting to "false", but had never been ported upstream — so the
// appliance failed closed while this codebase failed open. It is declared as a
// structural contract in the appliance's overlay registry so the two cannot
// drift apart again.
function shouldFallbackToGlobal(res: Response, configuredBase: string) {
  if (process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK !== "true"
    || res.status !== 403 || configuredBase === GLOBAL_MISTRAL_API_BASE) return false
  return res.clone().text()
    .then(text => text.includes("regional_inference_not_allowed") || text.includes('"code":"1914"') || text.includes("code\":1914"))
    .catch(() => false)
}

export async function fetchMistralChatCompletions(
  apiKey: string,
  payload: unknown,
  options: MistralFetchOptions = {},
) {
  const configuredBase = configuredMistralBase()
  const body = JSON.stringify(payload)
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }

  const res = await fetch(`${configuredBase}${CHAT_COMPLETIONS_PATH}`, {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  })

  if (await shouldFallbackToGlobal(res, configuredBase)) {
    console.warn("[mistral] Regional inference rejected; retrying against global Mistral API base")
    return fetch(`${GLOBAL_MISTRAL_API_BASE}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
    })
  }

  return res
}
