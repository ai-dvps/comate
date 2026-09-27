const SENSITIVE_NAME = String.raw`(?:password|passwd|pwd|token|api[-_\s]?key|secret|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)`;
const SENSITIVE_HEADER = String.raw`(?:authorization|proxy-authorization|x-api-key|x-auth-token|cookie|set-cookie)`;
const STANDALONE_TOKEN = String.raw`(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[a-z]-[A-Za-z0-9-]{10,})`;

/** Keep user-visible text recognizable without exposing embedded credentials. */
export function redactSensitiveText(text: string): string {
  return text
    // Known credential prefixes are sensitive even without a surrounding
    // label. Boundaries and minimum lengths preserve words such as "sketch"
    // and short placeholders such as "sk-test".
    .replace(new RegExp(`(^|[^A-Za-z0-9_-])${STANDALONE_TOKEN}(?=$|[^A-Za-z0-9_-])`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`(["'])(${SENSITIVE_HEADER})\\s*:\\s*[^"']*\\1`, 'gi'), '$1$2: [REDACTED]$1')
    .replace(new RegExp(`((${SENSITIVE_HEADER})\\s*:\\s*)(?:bearer\\s+)?[^\\s"']+`, 'gi'), '$1[REDACTED]')
    .replace(/(\bbearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(new RegExp(`(["'])(${SENSITIVE_NAME})\\1\\s*:\\s*(["'])[^"']*\\3`, 'gi'), '$1$2$1: $3[REDACTED]$3')
    .replace(new RegExp(`((?:^|[,{]\\s*)${SENSITIVE_NAME}\\s*:\\s*)([^,}\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:^|\\s)${SENSITIVE_NAME}\\s*=\\s*)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:^|\\s)--?${SENSITIVE_NAME}=)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:^|\\s)--?${SENSITIVE_NAME}\\s+)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(
      new RegExp(`(\\b${SENSITIVE_NAME}\\s+(?:is|was|equals?|value\\s+is)\\s+)(["']?)[A-Za-z0-9_+/=-]{8,}\\2`, 'gi'),
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^/@\s"']+@/gi, '$1[REDACTED]@')
    .replace(new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s"']*`, 'gi'), '$1[REDACTED]');
}
