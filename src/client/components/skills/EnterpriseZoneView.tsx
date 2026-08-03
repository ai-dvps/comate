import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useEnterpriseZoneStore,
  type EnterpriseSkillSort,
} from '../../stores/enterprise-zone-store'
import { useSkillsStore } from '../../stores/skills-store'
import SkillInstallModal from '../SkillInstallModal'
import EnterpriseDetail from './EnterpriseDetail'
import EnterpriseList from './EnterpriseList'
import EnterpriseSkillDetail from './EnterpriseSkillDetail'

interface EnterpriseZoneViewProps {
  active: boolean
  isOpen: boolean
  workspaceId?: string
  onInstalled?: () => void
  onSelectSkill?: (orgId: string, namespace: string, slug: string) => void
}

type EnterpriseLocation =
  | { view: 'list' }
  | { view: 'enterprise'; orgId: string }
  | { view: 'skill'; orgId: string; namespace: string; slug: string }

const EMPTY_SELECT_SKILL = () => undefined
const EMPTY_INSTALLED = () => undefined

export default function EnterpriseZoneView({
  active,
  isOpen,
  workspaceId = '',
  onInstalled = EMPTY_INSTALLED,
  onSelectSkill = EMPTY_SELECT_SKILL,
}: EnterpriseZoneViewProps) {
  const [location, setLocation] = useState<EnterpriseLocation>({ view: 'list' })
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
  const [enterpriseIndustry, setEnterpriseIndustry] = useState<string | undefined>()
  const [enterprisePageNumber, setEnterprisePageNumber] = useState(1)
  const [skillKeyword, setSkillKeyword] = useState('')
  const [skillSort, setSkillSort] = useState<EnterpriseSkillSort>('downloads')
  const [skillPageNumber, setSkillPageNumber] = useState(1)
  const [installSkill, setInstallSkill] = useState<{ source: string; name: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const enterpriseScrollTopRef = useRef(0)
  const skillScrollTopRef = useRef(0)
  const selectedEnterpriseRef = useRef<string | null>(null)
  const selectedSkillRef = useRef<string | null>(null)
  const industriesRequestedRef = useRef(false)
  const enterpriseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skillDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    industries,
    isLoadingIndustries,
    industriesError,
    enterprisePage,
    isLoadingEnterprises,
    enterprisesError,
    enterpriseDetail,
    isLoadingEnterprise,
    enterpriseError,
    skillPage,
    isLoadingSkills,
    skillsError,
    skillDetail,
    activeSkillKey,
    isLoadingSkill,
    skillError,
    fetchIndustries,
    fetchEnterprises,
    fetchEnterprise,
    fetchEnterpriseSkills,
    fetchEnterpriseSkill,
    reset,
  } = useEnterpriseZoneStore(useShallow((state) => ({
    industries: state.industries,
    isLoadingIndustries: state.isLoadingIndustries,
    industriesError: state.industriesError,
    enterprisePage: state.enterprisePage,
    isLoadingEnterprises: state.isLoadingEnterprises,
    enterprisesError: state.enterprisesError,
    enterpriseDetail: state.enterpriseDetail,
    isLoadingEnterprise: state.isLoadingEnterprise,
    enterpriseError: state.enterpriseError,
    skillPage: state.skillPage,
    isLoadingSkills: state.isLoadingSkills,
    skillsError: state.skillsError,
    skillDetail: state.skillDetail,
    activeSkillKey: state.activeSkillKey,
    isLoadingSkill: state.isLoadingSkill,
    skillError: state.skillError,
    fetchIndustries: state.fetchIndustries,
    fetchEnterprises: state.fetchEnterprises,
    fetchEnterprise: state.fetchEnterprise,
    fetchEnterpriseSkills: state.fetchEnterpriseSkills,
    fetchEnterpriseSkill: state.fetchEnterpriseSkill,
    reset: state.reset,
  })))

  const isListView = location.view === 'list'
  const installed = useSkillsStore((state) => state.installed)
  const hasIndustries = industries.length > 0

  useEffect(() => {
    if (!isOpen || !active || hasIndustries || isLoadingIndustries || industriesError || industriesRequestedRef.current) return
    industriesRequestedRef.current = true
    void fetchIndustries()
  }, [isOpen, active, hasIndustries, isLoadingIndustries, industriesError, fetchIndustries])

  useEffect(() => {
    if (!isOpen || !active || !isListView) return
    if (enterpriseDebounceRef.current) clearTimeout(enterpriseDebounceRef.current)
    enterpriseDebounceRef.current = setTimeout(() => {
      void fetchEnterprises({
        keyword: enterpriseKeyword,
        industry: enterpriseIndustry,
        page: enterprisePageNumber,
      })
    }, enterpriseKeyword ? 250 : 0)
    return () => {
      if (enterpriseDebounceRef.current) clearTimeout(enterpriseDebounceRef.current)
    }
  }, [
    isOpen,
    active,
    isListView,
    enterpriseKeyword,
    enterpriseIndustry,
    enterprisePageNumber,
    fetchEnterprises,
  ])

  useEffect(() => {
    if (!isOpen || !active || location.view !== 'enterprise') return
    void fetchEnterprise(location.orgId)
  }, [isOpen, active, location, fetchEnterprise])

  useEffect(() => {
    if (!isOpen || !active || location.view !== 'enterprise') return
    if (skillDebounceRef.current) clearTimeout(skillDebounceRef.current)
    skillDebounceRef.current = setTimeout(() => {
      void fetchEnterpriseSkills(location.orgId, {
        keyword: skillKeyword,
        sort: skillSort,
        page: skillPageNumber,
      })
    }, skillKeyword ? 250 : 0)
    return () => {
      if (skillDebounceRef.current) clearTimeout(skillDebounceRef.current)
    }
  }, [isOpen, active, location, skillKeyword, skillSort, skillPageNumber, fetchEnterpriseSkills])

  useEffect(() => {
    if (!isOpen || !active || location.view !== 'skill') return
    void fetchEnterpriseSkill(location.orgId, location.namespace, location.slug)
  }, [isOpen, active, location, fetchEnterpriseSkill])

  useEffect(() => {
    if (isOpen) return
    setLocation({ view: 'list' })
    setEnterpriseKeyword('')
    setEnterpriseIndustry(undefined)
    setEnterprisePageNumber(1)
    setSkillKeyword('')
    setSkillSort('downloads')
    setSkillPageNumber(1)
    setInstallSkill(null)
    enterpriseScrollTopRef.current = 0
    skillScrollTopRef.current = 0
    selectedEnterpriseRef.current = null
    selectedSkillRef.current = null
    industriesRequestedRef.current = false
    reset()
  }, [isOpen, reset])

  const selectEnterprise = (orgId: string) => {
    enterpriseScrollTopRef.current = rootRef.current?.parentElement?.scrollTop ?? 0
    selectedEnterpriseRef.current = orgId
    setSkillKeyword('')
    setSkillSort('downloads')
    setSkillPageNumber(1)
    setLocation({ view: 'enterprise', orgId })
  }

  const backToEnterprises = () => {
    setLocation({ view: 'list' })
    requestAnimationFrame(() => {
      const scrollContainer = rootRef.current?.parentElement
      if (scrollContainer) scrollContainer.scrollTop = enterpriseScrollTopRef.current
      const selectedOrgId = selectedEnterpriseRef.current
      if (!selectedOrgId || !rootRef.current) return
      const buttons = rootRef.current.querySelectorAll<HTMLButtonElement>('[data-enterprise-org]')
      Array.from(buttons).find((button) => button.dataset.enterpriseOrg === selectedOrgId)?.focus()
    })
  }

  const selectSkill = (orgId: string, namespace: string, slug: string) => {
    skillScrollTopRef.current = rootRef.current?.parentElement?.scrollTop ?? 0
    selectedSkillRef.current = `${namespace}/${slug}`
    setLocation({ view: 'skill', orgId, namespace, slug })
    onSelectSkill(orgId, namespace, slug)
  }

  const backToEnterprise = (orgId: string) => {
    setInstallSkill(null)
    setLocation({ view: 'enterprise', orgId })
    setTimeout(() => {
      const scrollContainer = rootRef.current?.parentElement
      if (scrollContainer) scrollContainer.scrollTop = skillScrollTopRef.current
      const selectedSkill = selectedSkillRef.current
      if (!selectedSkill || !rootRef.current) return
      const buttons = rootRef.current.querySelectorAll<HTMLButtonElement>('[data-enterprise-skill]')
      Array.from(buttons).find((button) => button.dataset.enterpriseSkill === selectedSkill)?.focus()
    }, 0)
  }

  const changeEnterpriseKeyword = (value: string) => {
    setEnterpriseKeyword(value)
    setEnterprisePageNumber(1)
  }

  const changeEnterpriseIndustry = (value?: string) => {
    setEnterpriseIndustry(value)
    setEnterprisePageNumber(1)
  }

  const clearEnterpriseFilters = () => {
    setEnterpriseKeyword('')
    setEnterpriseIndustry(undefined)
    setEnterprisePageNumber(1)
  }

  const changeSkillKeyword = (value: string) => {
    setSkillKeyword(value)
    setSkillPageNumber(1)
  }

  const changeSkillSort = (value: EnterpriseSkillSort) => {
    setSkillSort(value)
    setSkillPageNumber(1)
  }

  if (isListView) {
    return (
      <div ref={rootRef} className="contents">
        <EnterpriseList
          page={enterprisePage}
          industries={industries}
          keyword={enterpriseKeyword}
          industry={enterpriseIndustry}
          requestedPage={enterprisePageNumber}
          loading={isLoadingEnterprises}
          error={enterprisesError}
          industriesLoading={isLoadingIndustries}
          industriesError={industriesError}
          onKeywordChange={changeEnterpriseKeyword}
          onIndustryChange={changeEnterpriseIndustry}
          onPageChange={setEnterprisePageNumber}
          onClearFilters={clearEnterpriseFilters}
          onSelect={selectEnterprise}
          onRetry={() => void fetchEnterprises({
            keyword: enterpriseKeyword,
            industry: enterpriseIndustry,
            page: enterprisePageNumber,
          })}
          onRetryIndustries={() => {
            industriesRequestedRef.current = true
            void fetchIndustries()
          }}
        />
      </div>
    )
  }

  if (location.view === 'skill') {
    const currentSkillKey = `${location.orgId}:${location.namespace}/${location.slug}`
    const currentDetail = activeSkillKey === currentSkillKey
      ? skillDetail
      : null
    const exactSourceInstalled = currentDetail
      ? installed.some((skill) => skill.source === currentDetail.source)
      : false

    return (
      <div ref={rootRef} className="contents">
        <EnterpriseSkillDetail
          enterprise={enterpriseDetail?.orgId === location.orgId ? enterpriseDetail : null}
          detail={currentDetail}
          skillSlug={location.slug}
          loading={isLoadingSkill}
          error={skillError}
          installed={exactSourceInstalled}
          onBack={() => backToEnterprise(location.orgId)}
          onBackToList={backToEnterprises}
          onRetry={() => void fetchEnterpriseSkill(location.orgId, location.namespace, location.slug, true)}
          onInstall={() => {
            if (!currentDetail) return
            setInstallSkill({ source: currentDetail.source, name: currentDetail.slug })
          }}
        />
        {installSkill ? (
          <SkillInstallModal
            source={installSkill.source}
            fixedSkillName={installSkill.name}
            workspaceId={workspaceId}
            onClose={() => setInstallSkill(null)}
            onInstalled={() => {
              setInstallSkill(null)
              onInstalled()
            }}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="contents">
      <EnterpriseDetail
        detail={enterpriseDetail}
        industries={industries}
        detailLoading={isLoadingEnterprise}
        detailError={enterpriseError}
        skillPage={skillPage}
        skillKeyword={skillKeyword}
        skillSort={skillSort}
        requestedSkillPage={skillPageNumber}
        skillsLoading={isLoadingSkills}
        skillsError={skillsError}
        onBack={backToEnterprises}
        onRetryDetail={() => void fetchEnterprise(location.orgId, true)}
        onRetrySkills={() => void fetchEnterpriseSkills(location.orgId, {
          keyword: skillKeyword,
          sort: skillSort,
          page: skillPageNumber,
        })}
        onSkillKeywordChange={changeSkillKeyword}
        onSkillSortChange={changeSkillSort}
        onSkillPageChange={setSkillPageNumber}
        onSelectSkill={(namespace, slug) => selectSkill(location.orgId, namespace, slug)}
      />
    </div>
  )
}
