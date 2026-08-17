import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import type { FileContextTab } from '../stores/context-tab-store'
import CodeMirrorFileViewer from './CodeMirrorFileViewer'

describe('CodeMirrorFileViewer', () => {
  it('renders supported videos with native playback controls', () => {
    const tab: FileContextTab = {
      type: 'file',
      id: 'file:clip.mp4',
      workspaceId: 'ws-1',
      path: 'media/clip.mp4',
      name: 'clip.mp4',
      content: '',
      isBinary: true,
      videoUrl: 'http://localhost:1234/api/workspaces/ws-1/files/media?path=media%2Fclip.mp4',
      preview: false,
    }

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <CodeMirrorFileViewer tab={tab} workspacePath="/project" />
      </I18nextProvider>,
    )

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('src', tab.videoUrl)
    expect(screen.queryByText('Binary file changes cannot be shown')).not.toBeInTheDocument()
  })
})
