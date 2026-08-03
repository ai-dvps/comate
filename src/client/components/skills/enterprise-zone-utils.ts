import type { EnterpriseIndustry } from '../../stores/enterprise-zone-store'

export function formatCount(value: number): string {
  return value.toLocaleString()
}

export function industryLabels(industries: EnterpriseIndustry[], language: string): Map<string, string> {
  const prefersChinese = language.toLowerCase().startsWith('zh')
  return new Map(industries.map((industry) => [
    industry.key,
    prefersChinese ? industry.displayName : (industry.displayNameEn || industry.displayName),
  ]))
}
