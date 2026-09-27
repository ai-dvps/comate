import { useState, useEffect } from 'react'
import { GitBranch } from 'lucide-react'

interface WorkspaceGitBranchProps {
  workspaceId: string
}

export default function WorkspaceGitBranch({
  workspaceId,
}: WorkspaceGitBranchProps) {
  const [gitRef, setGitRef] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setGitRef(null)
      return
    }

    const fetchGitRef = () => {
      fetch(`/api/workspaces/${workspaceId}/git-ref`)
        .then((res) => res.json())
        .then((data: { ref?: string | null }) => setGitRef(data.ref ?? null))
        .catch(() => setGitRef(null))
    }

    fetchGitRef()
    const interval = setInterval(fetchGitRef, 10000)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchGitRef()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const handleFocus = () => {
      fetchGitRef()
    }
    window.addEventListener('focus', handleFocus)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [workspaceId])

  if (!gitRef) {
    return null
  }

  return (
    <span
      className="status-bar-git flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-text-tertiary"
      title={gitRef}
      aria-label={gitRef}
    >
      <GitBranch className="size-3" aria-hidden="true" />
      <span className="status-bar-branch-value" aria-hidden="true">{gitRef}</span>
    </span>
  )
}
