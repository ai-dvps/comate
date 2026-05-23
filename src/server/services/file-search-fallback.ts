// U4 placeholder — pure-Node fallback walker fills this in.
// Throws until then so the rg path is the only one exercised.

export interface FallbackInput {
  workspaceRoot: string;
  query: string;
  signal?: AbortSignal;
}

export async function fallbackWalk(
  _options: FallbackInput,
  _candidateBudget: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  throw new Error('fallback walker not yet implemented (U4)');
}
