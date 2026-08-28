export const UPDATE_FEED = {
  provider: 'github',
  owner: 'ai-dvps',
  repo: 'comate',
} as const;

export const GITEE_UPDATE_FEED = {
  provider: 'generic',
  url: 'https://gitee.com/ai-dvps/comate/releases/download/latest',
  // Gitee's release CDN currently ignores HTTP Range requests. Disable
  // electron-updater's multi-range differential request path so it can fall
  // back cleanly to a full package download.
  useMultipleRangeRequest: false,
} as const;

export const MISSING_UPDATE_FEED_ERROR = 'missing-update-feed';
