import { useState, useEffect, useCallback } from 'react'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'theme'

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialTheme(): { theme: Theme; isFollowingSystem: boolean } {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') {
      return { theme: stored, isFollowingSystem: false }
    }
    if (stored !== null) {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // localStorage not available
  }
  return { theme: getSystemTheme(), isFollowingSystem: true }
}

export function useTheme() {
  const [{ theme, isFollowingSystem }, setState] = useState(getInitialTheme)

  const applyTheme = useCallback((newTheme: Theme, followingSystem: boolean) => {
    setState({ theme: newTheme, isFollowingSystem: followingSystem })
    const root = document.documentElement
    if (newTheme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [])

  const setTheme = useCallback(
    (newTheme: Theme) => {
      try {
        localStorage.setItem(STORAGE_KEY, newTheme)
      } catch {
        // localStorage not available
      }
      applyTheme(newTheme, false)
    },
    [applyTheme]
  )

  const toggleTheme = useCallback(() => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
  }, [theme, setTheme])

  const resetToSystem = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // localStorage not available
    }
    applyTheme(getSystemTheme(), true)
  }, [applyTheme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = (e: MediaQueryListEvent) => {
      if (isFollowingSystem) {
        applyTheme(e.matches ? 'dark' : 'light', true)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [isFollowingSystem, applyTheme])

  return {
    theme,
    isFollowingSystem,
    setTheme,
    toggleTheme,
    resetToSystem,
  }
}
