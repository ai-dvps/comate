import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ExpertSkillDetail } from '../../stores/expert-packages-store'
import SkillHubSkillDetail from './SkillHubSkillDetail'

interface ExpertPackageSkillDetailProps {
  packageName: string
  detail?: ExpertSkillDetail
  loading: boolean
  error?: string
  installed?: boolean
  onBack: () => void
  onBackToList: () => void
  onRetry: () => void
  onInstall: () => void
}

export default function ExpertPackageSkillDetail({
  packageName, detail, loading, error, installed = false, onBack, onBackToList, onRetry, onInstall,
}: ExpertPackageSkillDetailProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <button type="button" onClick={onBackToList} className="hover:text-text-primary">{t('skills.expertPackages.back')}</button><span>/</span>
        <button type="button" onClick={onBack} className="hover:text-text-primary">{packageName}</button><span>/</span>
        <span className="truncate text-text-secondary">{detail?.displayName || ''}</span>
      </nav>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary"><ArrowLeft className="h-3.5 w-3.5" /> {t('skills.expertPackages.backToPackage')}</button>
      <SkillHubSkillDetail
        detail={detail}
        loading={loading}
        error={error}
        errorTitle={t('skills.expertPackages.skillDetailFailed')}
        retryLabel={t('skills.expertPackages.retry')}
        installed={installed}
        onRetry={onRetry}
        onInstall={onInstall}
      />
    </div>
  )
}
