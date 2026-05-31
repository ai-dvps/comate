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
    <span className="flex items-center gap-1 text-[11px] text-text-tertiary whitespace-nowrap shrink-0">
      <GitBranch className="w-3 h-3" />
      {gitRef}
    </span>
  )
}
