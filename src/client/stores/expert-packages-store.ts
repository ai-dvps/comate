import { create } from 'zustand'
import { responseErrorMessage } from '../lib/response-error'
import type { SkillHubSkillDetail } from '../types/skillhub'

export const EXPERT_PACKAGE_SCENES = [
  'academic', 'content-creation', 'design', 'ecommerce', 'education', 'finance',
  'healthcare', 'hr', 'legal', 'lifestyle', 'marketing', 'media', 'mysticism', 'tech',
] as const

export type ExpertPackageScene = typeof EXPERT_PACKAGE_SCENES[number]

export interface ExpertPackageSummary {
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

export interface ExpertPackageChild {
  namespace: string
  slug: string
  displayName: string
  summary: string
  available: boolean
  source: string
  securityReports?: ExpertSkillDetail['securityReports']
}

export interface ExpertPackageDetail extends ExpertPackageSummary {
  content: string
  contentEn?: string
  children: ExpertPackageChild[]
  complete: boolean
  unavailableReason?: string
}

export type ExpertSkillDetail = SkillHubSkillDetail

export interface ExpertPackageInstallResult {
  id: string
  kind: 'orchestrator' | 'skill'
  source: string
  name: string
  status: 'installed' | 'already-installed' | 'error'
  path?: string
  error?: string
}

interface ExpertPackagesState {
  packages: ExpertPackageSummary[]
  total: number
  isLoadingList: boolean
  listError: string | null
  packageDetails: Record<string, ExpertPackageDetail>
  loadingPackageSlug: string | null
  packageErrors: Record<string, string>
  skillDetails: Record<string, ExpertSkillDetail>
  loadingSkillKey: string | null
  skillErrors: Record<string, string>
  isInstalling: boolean
  installResults: ExpertPackageInstallResult[]
  installError: string | null
  fetchPackages: (input?: {
    keyword?: string
    scene?: ExpertPackageScene
    page?: number
    pageSize?: number
  }) => Promise<void>
  fetchPackage: (slug: string, force?: boolean) => Promise<ExpertPackageDetail | null>
  fetchSkill: (
    packageSlug: string,
    namespace: string,
    slug: string,
    force?: boolean,
  ) => Promise<ExpertSkillDetail | null>
  installPackage: (input: {
    packageSlug: string
    scope: 'project' | 'global'
    workspaceId?: string
    itemIds?: string[]
  }) => Promise<ExpertPackageInstallResult[]>
  clearInstall: () => void
  reset: () => void
}

const API_BASE = '/api/skills/expert-packages'
let activeListController: AbortController | null = null
let listRequestId = 0
let detailRequestId = 0
const packageRequestIds = new Map<string, number>()
const skillRequestIds = new Map<string, number>()

function mergeInstallResults(
  previous: ExpertPackageInstallResult[],
  next: ExpertPackageInstallResult[],
): ExpertPackageInstallResult[] {
  const nextById = new Map(next.map((result) => [result.id, result]))
  const previousIds = new Set(previous.map((result) => result.id))
  return [
    ...previous.map((result) => nextById.get(result.id) ?? result),
    ...next.filter((result) => !previousIds.has(result.id)),
  ]
}

export const useExpertPackagesStore = create<ExpertPackagesState>((set, get) => ({
  packages: [],
  total: 0,
  isLoadingList: false,
  listError: null,
  packageDetails: {},
  loadingPackageSlug: null,
  packageErrors: {},
  skillDetails: {},
  loadingSkillKey: null,
  skillErrors: {},
  isInstalling: false,
  installResults: [],
  installError: null,

  fetchPackages: async (input = {}) => {
    const requestId = ++listRequestId
    activeListController?.abort()
    const controller = new AbortController()
    activeListController = controller
    set({ isLoadingList: true, listError: null })
    const params = new URLSearchParams({
      page: String(input.page || 1),
      pageSize: String(input.pageSize || 20),
    })
    if (input.keyword?.trim()) params.set('keyword', input.keyword.trim())
    if (input.scene) params.set('scene', input.scene)
    try {
      const response = await fetch(`${API_BASE}?${params.toString()}`, { signal: controller.signal })
      if (requestId !== listRequestId) return
      if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Expert Packages'))
      const body = await response.json() as { packages?: ExpertPackageSummary[]; total?: number }
      if (requestId !== listRequestId) return
      set({ packages: body.packages || [], total: body.total || 0, isLoadingList: false })
    } catch (error) {
      if (controller.signal.aborted || requestId !== listRequestId) return
      set({ listError: (error as Error).message, isLoadingList: false })
    } finally {
      if (requestId === listRequestId) activeListController = null
    }
  },

  fetchPackage: async (slug, force = false) => {
    if (!force && get().packageDetails[slug]) return get().packageDetails[slug]
    const requestId = ++detailRequestId
    packageRequestIds.set(slug, requestId)
    set({ loadingPackageSlug: slug, packageErrors: { ...get().packageErrors, [slug]: '' } })
    try {
      const response = await fetch(`${API_BASE}/${encodeURIComponent(slug)}`)
      if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Expert Package'))
      const body = await response.json() as { package: ExpertPackageDetail }
      if (packageRequestIds.get(slug) !== requestId) return null
      set((state) => ({
        packageDetails: { ...state.packageDetails, [slug]: body.package },
        loadingPackageSlug: state.loadingPackageSlug === slug ? null : state.loadingPackageSlug,
      }))
      return body.package
    } catch (error) {
      if (packageRequestIds.get(slug) !== requestId) return null
      set((state) => ({
        packageErrors: { ...state.packageErrors, [slug]: (error as Error).message },
        loadingPackageSlug: state.loadingPackageSlug === slug ? null : state.loadingPackageSlug,
      }))
      return null
    } finally {
      if (packageRequestIds.get(slug) === requestId) packageRequestIds.delete(slug)
    }
  },

  fetchSkill: async (packageSlug, namespace, slug, force = false) => {
    const key = `${packageSlug}:${namespace}/${slug}`
    if (!force && get().skillDetails[key]) return get().skillDetails[key]
    const requestId = ++detailRequestId
    skillRequestIds.set(key, requestId)
    set({ loadingSkillKey: key, skillErrors: { ...get().skillErrors, [key]: '' } })
    try {
      const response = await fetch(
        `${API_BASE}/${encodeURIComponent(packageSlug)}/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
      )
      if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Skill details'))
      const body = await response.json() as { skill: ExpertSkillDetail }
      if (skillRequestIds.get(key) !== requestId) return null
      set((state) => ({
        skillDetails: { ...state.skillDetails, [key]: body.skill },
        loadingSkillKey: state.loadingSkillKey === key ? null : state.loadingSkillKey,
      }))
      return body.skill
    } catch (error) {
      if (skillRequestIds.get(key) !== requestId) return null
      set((state) => ({
        skillErrors: { ...state.skillErrors, [key]: (error as Error).message },
        loadingSkillKey: state.loadingSkillKey === key ? null : state.loadingSkillKey,
      }))
      return null
    } finally {
      if (skillRequestIds.get(key) === requestId) skillRequestIds.delete(key)
    }
  },

  installPackage: async ({ packageSlug, scope, workspaceId, itemIds }) => {
    set({ isInstalling: true, installError: null })
    try {
      const response = await fetch(`${API_BASE}/${encodeURIComponent(packageSlug)}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          ...(workspaceId ? { workspaceId } : {}),
          ...(itemIds ? { itemIds } : {}),
        }),
      })
      const body = await response.json() as { results?: ExpertPackageInstallResult[]; error?: string }
      const results = body.results || []
      set((state) => ({
        isInstalling: false,
        installResults: itemIds ? mergeInstallResults(state.installResults, results) : results,
        installError: response.ok ? null : body.error || 'Expert Package installation failed',
      }))
      return results
    } catch (error) {
      set({ isInstalling: false, installError: (error as Error).message })
      return []
    }
  },

  clearInstall: () => set({ installResults: [], installError: null, isInstalling: false }),

  reset: () => {
    activeListController?.abort()
    activeListController = null
    listRequestId += 1
    detailRequestId += 1
    packageRequestIds.clear()
    skillRequestIds.clear()
    set({
      packages: [], total: 0, isLoadingList: false, listError: null,
      packageDetails: {}, loadingPackageSlug: null, packageErrors: {},
      skillDetails: {}, loadingSkillKey: null, skillErrors: {},
      isInstalling: false, installResults: [], installError: null,
    })
  },
}))
