import { fireEvent, render, screen } from '@testing-library/react'
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

  it('shows a fallback when the browser cannot play the video', () => {
    const tab: FileContextTab = {
      type: 'file',
      id: 'file:broken.mp4',
      workspaceId: 'ws-1',
      path: 'media/broken.mp4',
      name: 'broken.mp4',
      content: '',
      isBinary: true,
      videoUrl: 'http://localhost:1234/api/workspaces/ws-1/files/media?path=media%2Fbroken.mp4',
      preview: false,
    }

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <CodeMirrorFileViewer tab={tab} workspacePath="/project" />
      </I18nextProvider>,
    )

    fireEvent.error(container.querySelector('video')!)

    expect(container.querySelector('video')).toBeNull()
    expect(
      screen.getByText('Unable to play this video. The file may be corrupt or use an unsupported codec.'),
    ).toBeInTheDocument()
  })

  it('renders supported audio files with native playback controls', () => {
    const tab: FileContextTab = {
      type: 'file',
      id: 'file:tone.wav',
      workspaceId: 'ws-1',
      path: 'media/tone.wav',
      name: 'tone.wav',
      content: '',
      isBinary: true,
      audioUrl: 'http://localhost:1234/api/workspaces/ws-1/files/media?path=media%2Ftone.wav',
      preview: false,
    }

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <CodeMirrorFileViewer tab={tab} workspacePath="/project" />
      </I18nextProvider>,
    )

    const audio = container.querySelector('audio')
    expect(audio).not.toBeNull()
    expect(audio).toHaveAttribute('controls')
    expect(audio).toHaveAttribute('src', tab.audioUrl)
    expect(screen.getByText('tone.wav')).toBeInTheDocument()
    expect(screen.queryByText('Binary file changes cannot be shown')).not.toBeInTheDocument()
  })

  it('shows a fallback when the browser cannot play the audio', () => {
    const tab: FileContextTab = {
      type: 'file',
      id: 'file:broken.wav',
      workspaceId: 'ws-1',
      path: 'media/broken.wav',
      name: 'broken.wav',
      content: '',
      isBinary: true,
      audioUrl: 'http://localhost:1234/api/workspaces/ws-1/files/media?path=media%2Fbroken.wav',
      preview: false,
    }

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <CodeMirrorFileViewer tab={tab} workspacePath="/project" />
      </I18nextProvider>,
    )

    fireEvent.error(container.querySelector('audio')!)

    expect(container.querySelector('audio')).toBeNull()
    expect(
      screen.getByText('Unable to play this audio. The file may be corrupt or use an unsupported codec.'),
    ).toBeInTheDocument()
  })

  it('renders header actions next to the copy button', () => {
    const tab: FileContextTab = {
      type: 'file',
      id: 'file:app.ts',
      workspaceId: 'ws-1',
      path: 'src/app.ts',
      name: 'app.ts',
      content: 'export {}',
      isBinary: false,
      preview: false,
    }

    render(
      <I18nextProvider i18n={i18n}>
        <CodeMirrorFileViewer
          tab={tab}
          workspacePath="/project"
          headerActions={<button type="button">navigator-toggle</button>}
        />
      </I18nextProvider>,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy content' })
    const actionButton = screen.getByRole('button', { name: 'navigator-toggle' })
    const header = screen.getByTestId('file-viewer-header')
    expect(header).toContainElement(copyButton)
    expect(header).toContainElement(actionButton)
    // The header action sits to the right of the copy button.
    expect(copyButton.compareDocumentPosition(actionButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
