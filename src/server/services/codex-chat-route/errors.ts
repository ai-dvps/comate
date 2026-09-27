export type ConverterErrorCode =
  | 'invalid_request'
  | 'unsupported_media'
  | 'unsupported_event'
  | 'continuity_state_required'
  | 'request_too_large'
  | 'image_limit_exceeded'
  | 'image_bytes_exceeded'
  | 'tool_arguments_too_large'
  | 'sse_frame_too_large'
  | 'response_too_large'
  | 'history_too_large'
  | 'malformed_sse'
  | 'upstream_stream_terminated'
  | 'upstream_authentication'
  | 'upstream_rate_limit'
  | 'upstream_timeout'
  | 'upstream_network'
  | 'upstream_server';

const SAFE_MESSAGES: Record<ConverterErrorCode, string> = {
  invalid_request: 'The Responses request is invalid.',
  unsupported_media: 'The request contains media unsupported by this Provider route.',
  unsupported_event: 'The upstream returned an unsupported response event.',
  continuity_state_required: 'The request omits tool history required by this Provider route.',
  request_too_large: 'The request exceeds the Provider route limit.',
  image_limit_exceeded: 'The request contains too many images.',
  image_bytes_exceeded: 'The request image data exceeds the Provider route limit.',
  tool_arguments_too_large: 'Tool arguments exceed the Provider route limit.',
  sse_frame_too_large: 'An upstream stream frame exceeds the Provider route limit.',
  response_too_large: 'The upstream response exceeds the Provider route limit.',
  history_too_large: 'The request history exceeds the Provider route limit.',
  malformed_sse: 'The upstream returned a malformed event stream.',
  upstream_stream_terminated: 'The upstream stream ended before completion.',
  upstream_authentication: 'The Provider rejected its configured credential.',
  upstream_rate_limit: 'The Provider rate limit was reached.',
  upstream_timeout: 'The Provider request timed out.',
  upstream_network: 'The Provider could not be reached.',
  upstream_server: 'The Provider returned a server error.',
};

export class ConverterError extends Error {
  constructor(
    readonly code: ConverterErrorCode,
    readonly status: number,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ConverterError';
  }

  toResponsesError(): Record<string, unknown> {
    return {
      error: {
        type: this.code,
        code: this.code,
        message: this.message,
      },
    };
  }
}

export function converterError(
  code: ConverterErrorCode,
  status = code === 'invalid_request' || code.startsWith('unsupported_') ? 400 : 502,
): ConverterError {
  return new ConverterError(code, status);
}

export function safeUpstreamError(input: {
  status?: number;
  timeout?: boolean;
  network?: boolean;
  /** Deliberately ignored. Raw upstream material must never reach the error. */
  detail?: unknown;
}): ConverterError {
  if (input.timeout) return new ConverterError('upstream_timeout', 504);
  if (input.network) return new ConverterError('upstream_network', 502);
  if (input.status === 401 || input.status === 403) {
    return new ConverterError('upstream_authentication', 502);
  }
  if (input.status === 429) return new ConverterError('upstream_rate_limit', 429);
  return new ConverterError('upstream_server', 502);
}

export interface ConverterLimits {
  maxRequestBytes: number;
  maxImages: number;
  maxImageBytes: number;
  maxToolArgumentBytes: number;
  maxSseFrameBytes: number;
  maxResponseBytes: number;
  maxHistoryBytes: number;
  maxHistoryItems: number;
}

export const DEFAULT_CONVERTER_LIMITS: Readonly<ConverterLimits> = Object.freeze({
  maxRequestBytes: 2 * 1024 * 1024,
  maxImages: 16,
  maxImageBytes: 8 * 1024 * 1024,
  maxToolArgumentBytes: 1024 * 1024,
  maxSseFrameBytes: 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxHistoryBytes: 4 * 1024 * 1024,
  maxHistoryItems: 512,
});

export function converterLimits(overrides?: Partial<ConverterLimits>): ConverterLimits {
  return { ...DEFAULT_CONVERTER_LIMITS, ...overrides };
}
