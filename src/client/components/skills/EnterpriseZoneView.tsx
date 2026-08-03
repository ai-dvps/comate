import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useEnterpriseZoneStore,
  type EnterpriseSkillSort,
} from '../../stores/enterprise-zone-store'
import EnterpriseDetail from './EnterpriseDetail'
import EnterpriseList from './EnterpriseList'

interface EnterpriseZoneViewProps {
  active: boolean
  isOpen: boolean
  onSelectSkill?: (orgId: string, namespace: string, slug: string) => void
}

type EnterpriseLocation =
  | { view: 'list' }
  | { view: 'enterprise'; orgId: string }

const EMPTY_SELECT_SKILL = () => undefined

export default function EnterpriseZoneView({
  active,
  isOpen,
  onSelectSkill = EMPTY_SELECT_SKILL,
}: EnterpriseZoneViewProps) {
  const [location, setLocation] = useState<EnterpriseLocation>({ view: 'list' })
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
  const [enterpriseIndustry, setEnterpriseIndustry] = useState<string | undefined>()
  const [enterprisePageNumber, setEnterprisePageNumber] = useState(1)
  const [skillKeyword, setSkillKeyword] = useState('')
  const [skillSort, setSkillSort] = useState<EnterpriseSkillSort>('downloads')
  const [skillPageNumber, setSkillPageNumber] = useState(1)
  const rootRef = useRef<HTMLDivElement>(null)
  const enterpriseScrollTopRef = useRef(0)
  const skillScrollTopRef = useRef(0)
  const selectedEnterpriseRef = useRef<string | null>(null)
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
    fetchIndustries,
    fetchEnterprises,
    fetchEnterprise,
    fetchEnterpriseSkills,
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
    fetchIndustries: state.fetchIndustries,
    fetchEnterprises: state.fetchEnterprises,
    fetchEnterprise: state.fetchEnterprise,
    fetchEnterpriseSkills: state.fetchEnterpriseSkills,
    reset: state.reset,
  })))

  const isListView = location.view === 'list'
  const activeOrgId = location.view === 'enterprise' ? location.orgId : null
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
    if (!isOpen || !active || !activeOrgId) return
    void fetchEnterprise(activeOrgId)
  }, [isOpen, active, activeOrgId, fetchEnterprise])

  useEffect(() => {
    if (!isOpen || !active || !activeOrgId) return
    if (skillDebounceRef.current) clearTimeout(skillDebounceRef.current)
    skillDebounceRef.current = setTimeout(() => {
      void fetchEnterpriseSkills(activeOrgId, {
        keyword: skillKeyword,
        sort: skillSort,
        page: skillPageNumber,
      })
    }, skillKeyword ? 250 : 0)
    return () => {
      if (skillDebounceRef.current) clearTimeout(skillDebounceRef.current)
    }
  }, [isOpen, active, activeOrgId, skillKeyword, skillSort, skillPageNumber, fetchEnterpriseSkills])

  useEffect(() => {
    if (isOpen) return
    setLocation({ view: 'list' })
    setEnterpriseKeyword('')
    setEnterpriseIndustry(undefined)
    setEnterprisePageNumber(1)
    setSkillKeyword('')
    setSkillSort('downloads')
    setSkillPageNumber(1)
    enterpriseScrollTopRef.current = 0
    skillScrollTopRef.current = 0
    selectedEnterpriseRef.current = null
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
    onSelectSkill(orgId, namespace, slug)
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
