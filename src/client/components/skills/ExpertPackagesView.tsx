import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useExpertPackagesStore,
  type ExpertPackageScene,
} from '../../stores/expert-packages-store'
import { useSkillsStore } from '../../stores/skills-store'
import SkillInstallModal from '../SkillInstallModal'
import ExpertPackageDetail from './ExpertPackageDetail'
import ExpertPackageInstallModal from './ExpertPackageInstallModal'
import ExpertPackageList, { type ExpertPackageViewMode } from './ExpertPackageList'
import ExpertPackageSkillDetail from './ExpertPackageSkillDetail'

interface ExpertPackagesViewProps {
  active: boolean
  isOpen: boolean
  workspaceId: string
  onInstalled: () => void
}

type Location =
  | { view: 'list' }
  | { view: 'package'; packageSlug: string }
  | { view: 'skill'; packageSlug: string; namespace: string; skillSlug: string }

const VIEW_MODE_KEY = 'comate.expert-packages.view-mode'

export default function ExpertPackagesView({ active, isOpen, workspaceId, onInstalled }: ExpertPackagesViewProps) {
  const [location, setLocation] = useState<Location>({ view: 'list' })
  const [keyword, setKeyword] = useState('')
  const [scene, setScene] = useState<ExpertPackageScene | undefined>()
  const [viewMode, setViewMode] = useState<ExpertPackageViewMode>(() => {
    try { return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards' } catch { return 'cards' }
  })
  const [installPackageSlug, setInstallPackageSlug] = useState<string | null>(null)
  const [installSkill, setInstallSkill] = useState<{ source: string; name: string } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listScrollTopRef = useRef(0)
  const installed = useSkillsStore((state) => state.installed)
  const {
    packages, total, isLoadingList, listError,
    packageDetails, loadingPackageSlug, packageErrors,
    skillDetails, loadingSkillKey, skillErrors,
    fetchPackages, fetchPackage, fetchSkill,
  } = useExpertPackagesStore(useShallow((state) => ({
    packages: state.packages,
    total: state.total,
    isLoadingList: state.isLoadingList,
    listError: state.listError,
    packageDetails: state.packageDetails,
    loadingPackageSlug: state.loadingPackageSlug,
    packageErrors: state.packageErrors,
    skillDetails: state.skillDetails,
    loadingSkillKey: state.loadingSkillKey,
    skillErrors: state.skillErrors,
    fetchPackages: state.fetchPackages,
    fetchPackage: state.fetchPackage,
    fetchSkill: state.fetchSkill,
  })))

  useEffect(() => {
    if (!active) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void fetchPackages({ keyword, scene, pageSize: 200 })
    }, keyword ? 250 : 0)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [active, keyword, scene, fetchPackages])

  useEffect(() => {
    if (isOpen) return
    setLocation({ view: 'list' })
    setKeyword('')
    setScene(undefined)
    setInstallPackageSlug(null)
    setInstallSkill(null)
    listScrollTopRef.current = 0
  }, [isOpen])

  const selectPackage = (slug: string) => {
    listScrollTopRef.current = rootRef.current?.parentElement?.scrollTop ?? 0
    setLocation({ view: 'package', packageSlug: slug })
    void fetchPackage(slug)
  }

  const backToList = () => {
    setLocation({ view: 'list' })
    requestAnimationFrame(() => {
      const scrollContainer = rootRef.current?.parentElement
      if (scrollContainer) scrollContainer.scrollTop = listScrollTopRef.current
    })
  }

  const selectSkill = (packageSlug: string, namespace: string, skillSlug: string) => {
    setLocation({ view: 'skill', packageSlug, namespace, skillSlug })
    void fetchSkill(packageSlug, namespace, skillSlug)
  }

  if (location.view === 'list') {
    return (
      <div ref={rootRef} className="contents">
        <ExpertPackageList
          packages={packages}
          total={total}
          keyword={keyword}
          scene={scene}
          viewMode={viewMode}
          loading={isLoadingList}
          error={listError}
          onKeywordChange={setKeyword}
          onSceneChange={setScene}
          onViewModeChange={(mode) => {
            setViewMode(mode)
            try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* storage unavailable */ }
          }}
          onSelect={selectPackage}
          onRetry={() => void fetchPackages({ keyword, scene, pageSize: 200 })}
        />
      </div>
    )
  }

  const packageDetail = packageDetails[location.packageSlug]
  const isPackageInstalled = installed.some((skill) => skill.source === `skillhub-package:${location.packageSlug}`)

  return (
    <div ref={rootRef} className="contents">
      {location.view === 'package' ? (
        <ExpertPackageDetail
          detail={packageDetail}
          loading={loadingPackageSlug === location.packageSlug}
          error={packageErrors[location.packageSlug]}
          installed={isPackageInstalled}
          onBack={backToList}
          onRetry={() => void fetchPackage(location.packageSlug, true)}
          onSelectSkill={(namespace, slug) => selectSkill(location.packageSlug, namespace, slug)}
          onInstall={() => setInstallPackageSlug(location.packageSlug)}
        />
      ) : (
        <ExpertPackageSkillDetail
          packageName={packageDetail?.displayName || location.packageSlug}
          detail={skillDetails[`${location.packageSlug}:${location.namespace}/${location.skillSlug}`]}
          loading={loadingSkillKey === `${location.packageSlug}:${location.namespace}/${location.skillSlug}`}
          error={skillErrors[`${location.packageSlug}:${location.namespace}/${location.skillSlug}`]}
          installed={installed.some((skill) => skill.source === `skillhub-cn:${location.namespace}/${location.skillSlug}`)}
          onBack={() => setLocation({ view: 'package', packageSlug: location.packageSlug })}
          onBackToList={backToList}
          onRetry={() => void fetchSkill(location.packageSlug, location.namespace, location.skillSlug, true)}
          onInstall={() => setInstallSkill({
            source: `skillhub-cn:${location.namespace}/${location.skillSlug}`,
            name: location.skillSlug,
          })}
        />
      )}

      {installPackageSlug && packageDetails[installPackageSlug] && (
        <ExpertPackageInstallModal
          detail={packageDetails[installPackageSlug]}
          workspaceId={workspaceId}
          onClose={() => setInstallPackageSlug(null)}
          onCompleted={onInstalled}
        />
      )}
      {installSkill && (
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
      )}
    </div>
  )
}
