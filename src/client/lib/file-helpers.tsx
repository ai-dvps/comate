import { FileAudio, FileCode, FileJson, FileText, File } from 'lucide-react'

const AUDIO_ICON_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'oga', 'ogg', 'opus', 'weba'])

export function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    return <FileCode className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
  }
  if (ext === 'json') {
    return <FileJson className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
  }
  if (AUDIO_ICON_EXTENSIONS.has(ext ?? '')) {
    return <FileAudio className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
  }
  if (ext === 'md' || ext === 'txt') {
    return <FileText className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />
  }
  return <File className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
}

export function isMarkdown(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}
