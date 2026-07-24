const GLOBAL_MISTRAL_API_BASE = "https://api.mistral.ai/v1"
const CHAT_COMPLETIONS_PATH = "/chat/completions"

type MistralFetchOptions = {
  signal?: AbortSignal
}

function configuredMistralBase() {
  return (process.env.MISTRAL_API_BASE ?? GLOBAL_MISTRAL_API_BASE).replace(/\/$/, "")
}

function shouldFallbackToGlobal(res: Response, configuredBase: string) {
  if (res.status !== 403 || configuredBase === GLOBAL_MISTRAL_API_BASE) return false
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
