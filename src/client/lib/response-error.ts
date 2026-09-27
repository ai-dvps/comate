export async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return body.error || fallback
  } catch {
    return fallback
  }
}
