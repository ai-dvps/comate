import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { EnterpriseDetail, EnterpriseSkillDetail as EnterpriseSkillDetailData } from '../../stores/enterprise-zone-store'
import SkillHubSkillDetail from './SkillHubSkillDetail'

interface EnterpriseSkillDetailProps {
  enterprise?: EnterpriseDetail | null
  detail?: EnterpriseSkillDetailData | null
  skillSlug: string
  loading: boolean
  error?: string | null
  installed?: boolean
  onBack: () => void
  onBackToList: () => void
  onRetry: () => void
  onInstall: () => void
}

export default function EnterpriseSkillDetail({
  enterprise,
  detail,
  skillSlug,
  loading,
  error,
  installed = false,
  onBack,
  onBackToList,
  onRetry,
  onInstall,
}: EnterpriseSkillDetailProps) {
  const { t } = useTranslation('settings')
  const enterpriseName = enterprise?.name || t('skills.enterpriseZone.enterpriseFallback')
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex items-center gap-1.5 text-xs text-text-tertiary" aria-label={t('skills.enterpriseZone.skillBreadcrumb')}>
        <button type="button" onClick={onBackToList} className="hover:text-text-primary">{t('skills.enterpriseZone.enterprises')}</button><span>/</span>
        <button type="button" onClick={onBack} className="hover:text-text-primary">{enterpriseName}</button><span>/</span>
        <span className="truncate text-text-secondary">{detail?.displayName || skillSlug}</span>
      </nav>
      <button type="button" onClick={onBack} aria-label={t('skills.enterpriseZone.backToEnterpriseSkills')} title={t('skills.enterpriseZone.backToEnterpriseSkills')} className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary"><ArrowLeft className="h-3.5 w-3.5" /> {t('skills.enterpriseZone.backToEnterpriseSkills')}</button>
      <SkillHubSkillDetail
        detail={detail}
        loading={loading}
        error={error}
        errorTitle={t('skills.enterpriseZone.skillLoadFailed')}
        retryLabel={t('skills.enterpriseZone.retrySkill')}
        contextLabel={t('skills.enterpriseZone.publishedBy', { enterprise: enterpriseName })}
        installed={installed}
        onRetry={onRetry}
        onInstall={onInstall}
      />
    </div>
  )
}
