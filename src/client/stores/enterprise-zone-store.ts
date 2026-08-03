import { create } from 'zustand'
import { responseErrorMessage } from '../lib/response-error'
import type { SkillHubSkillDetail } from '../types/skillhub'

export const ENTERPRISE_ZONE_PAGE_SIZE = 20

export interface EnterpriseIndustry {
  key: string
  displayName: string
  displayNameEn?: string
  sortOrder: number
}

export interface EnterpriseSummary {
  orgId: string
  name: string
  fullName?: string
  shortName?: string
  description: string
  industryTags: string[]
  logoUrl?: string
  publishedSkillCount: number
  totalDownloads: number
}

export interface EnterpriseDetail extends EnterpriseSummary {
  totalStars: number
}

export type EnterpriseSkillSort = 'downloads' | 'stars' | 'latest'

export interface EnterpriseSkillSummary {
  namespace: string
  slug: string
  displayName: string
  summary: string
  downloads: number
  stars: number
  iconUrl?: string
}

export interface EnterprisePage {
  enterprises: EnterpriseSummary[]
  page: number
  pageSize: number
  total: number
}

export interface EnterpriseSkillPage {
  skills: EnterpriseSkillSummary[]
  page: number
  pageSize: number
  total: number
}

export type EnterpriseSkillDetail = SkillHubSkillDetail

interface EnterpriseZoneState {
  industries: EnterpriseIndustry[]
  isLoadingIndustries: boolean
  industriesError: string | null

  enterprisePage: EnterprisePage | null
  isLoadingEnterprises: boolean
  enterprisesError: string | null

  activeEnterpriseOrgId: string | null
  enterpriseDetail: EnterpriseDetail | null
  isLoadingEnterprise: boolean
  enterpriseError: string | null

  skillPage: EnterpriseSkillPage | null
  isLoadingSkills: boolean
  skillsError: string | null

  activeSkillKey: string | null
  skillDetail: EnterpriseSkillDetail | null
  isLoadingSkill: boolean
  skillError: string | null

  fetchIndustries: () => Promise<EnterpriseIndustry[] | null>
  fetchEnterprises: (input?: {
    keyword?: string
    industry?: string
    page?: number
  }) => Promise<EnterprisePage | null>
  fetchEnterprise: (orgId: string, force?: boolean) => Promise<EnterpriseDetail | null>
  fetchEnterpriseSkills: (
    orgId: string,
    input?: { keyword?: string; sort?: EnterpriseSkillSort; page?: number },
  ) => Promise<EnterpriseSkillPage | null>
  fetchEnterpriseSkill: (
    orgId: string,
    namespace: string,
    slug: string,
    force?: boolean,
  ) => Promise<EnterpriseSkillDetail | null>
  reset: () => void
}

const API_BASE = '/api/skills/enterprise-zone'

let industriesController: AbortController | null = null
let enterprisesController: AbortController | null = null
let enterpriseController: AbortController | null = null
let skillsController: AbortController | null = null
let skillController: AbortController | null = null

let industriesGeneration = 0
let enterprisesGeneration = 0
let enterpriseGeneration = 0
let skillsGeneration = 0
let skillGeneration = 0

// These identities protect refresh behavior; navigation and query snapshots remain view-owned.
let enterprisePageQueryIdentity: string | null = null
let skillPageQueryIdentity: string | null = null

function normalizedKeyword(keyword: string | undefined): string {
  return keyword?.trim() || ''
}

function enterpriseQueryIdentity(keyword: string, industry: string | undefined): string {
  return JSON.stringify([keyword, industry || ''])
}

function skillsQueryIdentity(orgId: string, keyword: string, sort: EnterpriseSkillSort): string {
  return JSON.stringify([orgId, keyword, sort])
}

function skillKey(orgId: string, namespace: string, slug: string): string {
  return `${orgId}:${namespace}/${slug}`
}

function abortEnterpriseChain(): void {
  enterpriseController?.abort()
  skillsController?.abort()
  skillController?.abort()
  enterpriseController = null
  skillsController = null
  skillController = null
  enterpriseGeneration += 1
  skillsGeneration += 1
  skillGeneration += 1
  skillPageQueryIdentity = null
}

export const useEnterpriseZoneStore = create<EnterpriseZoneState>((set, get) => {
  const activateEnterprise = (orgId: string): void => {
    if (get().activeEnterpriseOrgId === orgId) return
    abortEnterpriseChain()
    set({
      activeEnterpriseOrgId: orgId,
      enterpriseDetail: null,
      isLoadingEnterprise: false,
      enterpriseError: null,
      skillPage: null,
      isLoadingSkills: false,
      skillsError: null,
      activeSkillKey: null,
      skillDetail: null,
      isLoadingSkill: false,
      skillError: null,
    })
  }

  return {
    industries: [],
    isLoadingIndustries: false,
    industriesError: null,

    enterprisePage: null,
    isLoadingEnterprises: false,
    enterprisesError: null,

    activeEnterpriseOrgId: null,
    enterpriseDetail: null,
    isLoadingEnterprise: false,
    enterpriseError: null,

    skillPage: null,
    isLoadingSkills: false,
    skillsError: null,

    activeSkillKey: null,
    skillDetail: null,
    isLoadingSkill: false,
    skillError: null,

    fetchIndustries: async () => {
      const generation = ++industriesGeneration
      industriesController?.abort()
      const controller = new AbortController()
      industriesController = controller
      set({ isLoadingIndustries: true, industriesError: null })
      try {
        const response = await fetch(`${API_BASE}/industries`, { signal: controller.signal })
        if (generation !== industriesGeneration) return null
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Enterprise industries'))
        const body = await response.json() as { industries?: EnterpriseIndustry[] }
        if (generation !== industriesGeneration) return null
        const industries = body.industries || []
        set({ industries, isLoadingIndustries: false })
        return industries
      } catch (error) {
        if (controller.signal.aborted || generation !== industriesGeneration) return null
        set({ industriesError: (error as Error).message, isLoadingIndustries: false })
        return null
      } finally {
        if (generation === industriesGeneration) industriesController = null
      }
    },

    fetchEnterprises: async (input = {}) => {
      const keyword = normalizedKeyword(input.keyword)
      const page = input.page || 1
      const queryIdentity = enterpriseQueryIdentity(keyword, input.industry)
      const generation = ++enterprisesGeneration
      enterprisesController?.abort()
      const controller = new AbortController()
      enterprisesController = controller
      set({
        isLoadingEnterprises: true,
        enterprisesError: null,
        ...(enterprisePageQueryIdentity !== null && enterprisePageQueryIdentity !== queryIdentity
          ? { enterprisePage: null }
          : {}),
      })
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(ENTERPRISE_ZONE_PAGE_SIZE),
      })
      if (keyword) params.set('keyword', keyword)
      if (input.industry) params.set('industry', input.industry)
      try {
        const response = await fetch(`${API_BASE}/enterprises?${params.toString()}`, {
          signal: controller.signal,
        })
        if (generation !== enterprisesGeneration) return null
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Enterprises'))
        const body = await response.json() as EnterprisePage
        if (generation !== enterprisesGeneration) return null
        enterprisePageQueryIdentity = queryIdentity
        set({ enterprisePage: body, isLoadingEnterprises: false })
        return body
      } catch (error) {
        if (
          controller.signal.aborted
          || generation !== enterprisesGeneration
        ) return null
        set({ enterprisesError: (error as Error).message, isLoadingEnterprises: false })
        return null
      } finally {
        if (generation === enterprisesGeneration) enterprisesController = null
      }
    },

    fetchEnterprise: async (orgId, force = false) => {
      activateEnterprise(orgId)
      if (!force && get().enterpriseDetail?.orgId === orgId) return get().enterpriseDetail
      const generation = ++enterpriseGeneration
      enterpriseController?.abort()
      const controller = new AbortController()
      enterpriseController = controller
      set({ isLoadingEnterprise: true, enterpriseError: null })
      try {
        const response = await fetch(`${API_BASE}/enterprises/${encodeURIComponent(orgId)}`, {
          signal: controller.signal,
        })
        if (generation !== enterpriseGeneration || get().activeEnterpriseOrgId !== orgId) return null
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Enterprise'))
        const body = await response.json() as { enterprise: EnterpriseDetail }
        if (generation !== enterpriseGeneration || get().activeEnterpriseOrgId !== orgId) return null
        set({ enterpriseDetail: body.enterprise, isLoadingEnterprise: false })
        return body.enterprise
      } catch (error) {
        if (controller.signal.aborted || generation !== enterpriseGeneration || get().activeEnterpriseOrgId !== orgId) {
          return null
        }
        set({ enterpriseError: (error as Error).message, isLoadingEnterprise: false })
        return null
      } finally {
        if (generation === enterpriseGeneration) enterpriseController = null
      }
    },

    fetchEnterpriseSkills: async (orgId, input = {}) => {
      activateEnterprise(orgId)
      const keyword = normalizedKeyword(input.keyword)
      const sort = input.sort || 'downloads'
      const page = input.page || 1
      const queryIdentity = skillsQueryIdentity(orgId, keyword, sort)
      const generation = ++skillsGeneration
      skillsController?.abort()
      const controller = new AbortController()
      skillsController = controller
      set({
        isLoadingSkills: true,
        skillsError: null,
        ...(skillPageQueryIdentity !== null && skillPageQueryIdentity !== queryIdentity
          ? { skillPage: null }
          : {}),
      })
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(ENTERPRISE_ZONE_PAGE_SIZE),
      })
      if (keyword) params.set('keyword', keyword)
      params.set('sort', sort)
      try {
        const response = await fetch(
          `${API_BASE}/enterprises/${encodeURIComponent(orgId)}/skills?${params.toString()}`,
          { signal: controller.signal },
        )
        if (
          generation !== skillsGeneration
          || get().activeEnterpriseOrgId !== orgId
        ) return null
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Enterprise Skills'))
        const body = await response.json() as EnterpriseSkillPage
        if (
          generation !== skillsGeneration
          || get().activeEnterpriseOrgId !== orgId
        ) return null
        skillPageQueryIdentity = queryIdentity
        set({ skillPage: body, isLoadingSkills: false })
        return body
      } catch (error) {
        if (
          controller.signal.aborted
          || generation !== skillsGeneration
          || get().activeEnterpriseOrgId !== orgId
        ) return null
        set({ skillsError: (error as Error).message, isLoadingSkills: false })
        return null
      } finally {
        if (generation === skillsGeneration) skillsController = null
      }
    },

    fetchEnterpriseSkill: async (orgId, namespace, slug, force = false) => {
      activateEnterprise(orgId)
      const key = skillKey(orgId, namespace, slug)
      if (!force && get().activeSkillKey === key && get().skillDetail) return get().skillDetail
      const generation = ++skillGeneration
      skillController?.abort()
      const controller = new AbortController()
      skillController = controller
      set({
        activeSkillKey: key,
        skillDetail: get().activeSkillKey === key ? get().skillDetail : null,
        isLoadingSkill: true,
        skillError: null,
      })
      try {
        const response = await fetch(
          `${API_BASE}/enterprises/${encodeURIComponent(orgId)}/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
          { signal: controller.signal },
        )
        if (
          generation !== skillGeneration
          || get().activeEnterpriseOrgId !== orgId
          || get().activeSkillKey !== key
        ) return null
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'Failed to load Enterprise Skill'))
        const body = await response.json() as { skill: EnterpriseSkillDetail }
        if (
          generation !== skillGeneration
          || get().activeEnterpriseOrgId !== orgId
          || get().activeSkillKey !== key
        ) return null
        set({ skillDetail: body.skill, isLoadingSkill: false })
        return body.skill
      } catch (error) {
        if (
          controller.signal.aborted
          || generation !== skillGeneration
          || get().activeEnterpriseOrgId !== orgId
          || get().activeSkillKey !== key
        ) return null
        set({ skillError: (error as Error).message, isLoadingSkill: false })
        return null
      } finally {
        if (generation === skillGeneration) skillController = null
      }
    },

    reset: () => {
      industriesController?.abort()
      enterprisesController?.abort()
      abortEnterpriseChain()
      industriesController = null
      enterprisesController = null
      industriesGeneration += 1
      enterprisesGeneration += 1
      enterprisePageQueryIdentity = null
      set({
        industries: [],
        isLoadingIndustries: false,
        industriesError: null,
        enterprisePage: null,
        isLoadingEnterprises: false,
        enterprisesError: null,
        activeEnterpriseOrgId: null,
        enterpriseDetail: null,
        isLoadingEnterprise: false,
        enterpriseError: null,
        skillPage: null,
        isLoadingSkills: false,
        skillsError: null,
        activeSkillKey: null,
        skillDetail: null,
        isLoadingSkill: false,
        skillError: null,
      })
    },
  }
})
