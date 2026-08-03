export interface SkillHubSkillDetail {
  namespace: string
  slug: string
  displayName: string
  summary: string
  category: string
  owner: { handle: string; displayName: string }
  publisher?: { orgId: string }
  version: string
  stats: { downloads: number; installs: number }
  securityReports: Array<{
    provider: string
    status: string
    statusText: string
    reportUrl?: string
  }>
  documentation?: string
  source: string
}
