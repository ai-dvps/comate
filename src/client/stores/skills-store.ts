import { create } from 'zustand'

export type SkillScope = 'project' | 'global' | 'builtin'
export interface InstalledSkill {
  name: string
  kind?: 'skill' | 'expert-package-orchestrator'
  description?: string
  scope: SkillScope
  source: string
  /** Expert Package that installed this Skill, if it belongs to one. */
  packageSlug?: string
  /** Catalog summary cached at Expert Package installation time for offline display. */
  packageCatalog?: {
    slug: string
    displayName: string
    displayNameEn?: string
    summary: string
    summaryEn?: string
    scene: string
    subScene?: string
    skillCount: number
    source: 'skillhub.cn'
  }
  installPath: string
  isLegacySymlink: boolean
  computedHash?: string
  updatedAt?: string
  installedAt?: string
}

interface SkillsState {
  installed: InstalledSkill[]
  isFetchingInstalled: boolean
  error: string | null
  fetchInstalled: (workspaceId?: string) => Promise<void>
}
let generation = 0
export const useSkillsStore = create<SkillsState>((set) => ({
  installed: [], isFetchingInstalled: false, error: null,
  fetchInstalled: async (workspaceId) => {
    const current = ++generation
    set({ isFetchingInstalled: true, error: null, installed: [] })
    try {
      const response = await fetch(`/api/skills/installed${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (generation === current) set({ installed: data.skills ?? [] })
    } catch (error) {
      if (generation === current) set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (generation === current) set({ isFetchingInstalled: false })
    }
  },
}))
