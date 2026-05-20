import type { BundledLanguage } from 'shiki'

export const EXT_TO_LANGUAGE: Record<string, BundledLanguage> = {
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  ps1: 'powershell',
  pl: 'perl',
  kt: 'kotlin',
  kts: 'kotlin',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  fs: 'fsharp',
  fsx: 'fsharp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  vim: 'viml',
  dockerfile: 'dockerfile',
  tf: 'hcl',
  hcl: 'hcl',
  yml: 'yaml',
  m: 'objc',
  mm: 'objc',
}

export function getLanguageFromFilename(name: string): BundledLanguage {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'text' as BundledLanguage
  return EXT_TO_LANGUAGE[ext] ?? (ext as BundledLanguage)
}
