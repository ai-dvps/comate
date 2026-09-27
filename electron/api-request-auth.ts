export type RequestHeaders = Record<string, string | string[]>

export function addSidecarAuthorization(
  requestHeaders: RequestHeaders,
  token: string,
): RequestHeaders {
  const hasAuthorization = Object.keys(requestHeaders).some(
    (name) => name.toLowerCase() === 'authorization',
  )
  if (hasAuthorization) return requestHeaders
  return { ...requestHeaders, Authorization: `Bearer ${token}` }
}
