import type { EnterpriseIndustry } from '../../stores/enterprise-zone-store'

export function formatCount(value: number): string {
  return value.toLocaleString()
}

export function industryLabels(industries: EnterpriseIndustry[]): Map<string, string> {
  return new Map(industries.map((industry) => [industry.key, industry.displayName]))
}
