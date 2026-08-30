import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useContextTabStore } from '../../stores/context-tab-store'
import { useGitGraphStore, type GitGraphCommitDetail, type GitGraphSnapshot } from '../../stores/git-graph-store'
import GitGraphPanel from './GitGraphPanel'

const snapshot: GitGraphSnapshot = {
  capability: {
    isGitWorktree: true,
    state: 'attached',
    branch: 'feature/graph',
    ref: 'refs/heads/feature/graph',
    headHash: 'cccccccccccccccccccccccccccccccccccccccc',
  },
  refs: [
    { fullName: 'refs/heads/feature/graph', name: 'feature/graph', type: 'local', hash: 'cccccccccccccccccccccccccccccccccccccccc' },
    { fullName: 'refs/remotes/origin/main', name: 'origin/main', type: 'remote', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { fullName: 'refs/tags/v1.0.0', name: 'v1.0.0', type: 'tag', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ],
  commits: [
    {
      hash: 'cccccccccccccccccccccccccccccccccccccccc', shortHash: 'ccccccc',
      parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      authorName: 'Chen', authorEmail: 'chen@example.com', authoredAt: '2026-08-30T12:00:00.000Z',
      subject: 'Merge graph controls', refs: [{ fullName: 'refs/heads/feature/graph', name: 'feature/graph', type: 'local', hash: 'cccccccccccccccccccccccccccccccccccccccc' }], isHead: true,
    },
    {
      hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shortHash: 'bbbbbbb', parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      authorName: 'Alex', authorEmail: 'alex@example.com', authoredAt: '2026-08-29T12:00:00.000Z',
      subject: 'Build graph rows', refs: [], isHead: false,
    },
    {
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortHash: 'aaaaaaa', parents: [],
      authorName: 'Rin', authorEmail: 'rin@example.com', authoredAt: '2026-08-28T12:00:00.000Z',
      subject: 'Initial commit', refs: [
        { fullName: 'refs/remotes/origin/main', name: 'origin/main', type: 'remote', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { fullName: 'refs/tags/v1.0.0', name: 'v1.0.0', type: 'tag', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      ], isHead: false,
    },
  ],
  limit: 100,
  hasMore: true,
}

const detail: GitGraphCommitDetail = {
  hash: snapshot.commits[0].hash,
  shortHash: 'ccccccc',
  parents: snapshot.commits[0].parents,
  authorName: 'Chen',
  authorEmail: 'chen@example.com',
  authoredAt: '2026-08-30T12:00:00.000Z',
  subject: 'Merge graph controls',
  baseHash: snapshot.commits[0].parents[0],
  files: [{ path: 'src/graph.tsx', status: 'M', additions: 12, deletions: 3, isBinary: false, isGitlink: false }],
  filesTruncated: false,
  stats: { files: 1, additions: 12, deletions: 3 },
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18n}>
      <GitGraphPanel workspaceId="ws-1" />
    </I18nextProvider>,
  )
}

describe('GitGraphPanel', () => {
  beforeEach(() => {
    useGitGraphStore.getState().reset()
    useContextTabStore.getState().reset()
    useContextTabStore.getState().setContext('ws-1', null)
    global.fetch = vi.fn(async (input) => {
      const url = String(input)
      const selected = snapshot.commits.find((commit) => url.endsWith(`/${commit.hash}`))
      if (selected) return jsonResponse({
        ...detail,
        hash: selected.hash,
        shortHash: selected.shortHash,
        parents: selected.parents,
        subject: selected.subject,
        baseHash: selected.parents[0] ?? null,
      })
      if (url.includes('ref=refs%2Fremotes%2Forigin%2Fmain')) {
        return jsonResponse({ ...snapshot, commits: [snapshot.commits[2]] })
      }
      return jsonResponse(snapshot)
    }) as typeof global.fetch
  })

  it('browses topology, refs, HEAD and opens a changed file in an independent Diff tab', async () => {
    useContextTabStore.getState().openGitGraph('ws-1')
    const graphView = renderPanel()

    const list = await screen.findByRole('listbox', { name: 'Commit history' })
    Object.defineProperty(list, 'scrollTop', { value: 54, writable: true })
    fireEvent.scroll(list)
    const head = await within(list).findByRole('option', { name: /Merge graph controls/ })
    expect(head).toHaveAttribute('aria-selected', 'true')
    expect(head).toHaveTextContent('HEAD')
    expect(head).toHaveTextContent('feature/graph')
    expect(screen.getByText('origin/main').closest('[data-ref-type]')).toHaveAttribute('data-ref-type', 'remote')
    expect(screen.getByText('v1.0.0').closest('[data-ref-type]')).toHaveAttribute('data-ref-type', 'tag')

    expect(await screen.findByText('Compared with first parent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /src\/graph\.tsx/ }))
    await waitFor(() => expect(useContextTabStore.getState().activeTabId).toMatch(/^commit-diff:/))
    expect(useGitGraphStore.getState().workspaces['ws-1'].selectedCommitHash).toBe(snapshot.commits[0].hash)

    graphView.unmount()
    useContextTabStore.getState().openGitGraph('ws-1')
    renderPanel()
    const restoredList = await screen.findByRole('listbox', { name: 'Commit history' })
    await waitFor(() => expect(restoredList.scrollTop).toBe(54))
    expect(screen.getByRole('option', { name: /Merge graph controls/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('supports loaded-window search, branch filters, HEAD location, load more and keyboard selection', async () => {
    renderPanel()
    await screen.findByRole('listbox', { name: 'Commit history' })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded commits' }), { target: { value: 'Alex' } })
    expect(screen.getByText('1 of 1 loaded match')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))

    const second = screen.getByRole('option', { name: /Build graph rows/ })
    fireEvent.keyDown(screen.getByRole('option', { name: /Merge graph controls/ }), { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'Enter' })
    await waitFor(() => expect(useGitGraphStore.getState().workspaces['ws-1'].selectedCommitHash).toBe(snapshot.commits[1].hash))

    fireEvent.click(screen.getByRole('button', { name: 'Filter branches' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'origin/main' }))
    await waitFor(() => expect(useGitGraphStore.getState().workspaces['ws-1'].selectedRefs).toEqual(['refs/remotes/origin/main']))

    fireEvent.click(screen.getByRole('button', { name: 'Locate HEAD' }))
    expect(await screen.findByText('HEAD is outside the active branch filter.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more commits' }))
    await waitFor(() => expect(useGitGraphStore.getState().workspaces['ws-1'].loadedLimit).toBe(200))
  })

  it('keeps the graph visible when commit details fail and exposes a retry', async () => {
    global.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith(`/${snapshot.commits[0].hash}`)) return jsonResponse({ error: 'detail exploded' }, false)
      return jsonResponse(snapshot)
    }) as typeof global.fetch

    renderPanel()
    expect(await screen.findByRole('listbox', { name: 'Commit history' })).toBeInTheDocument()
    expect(await screen.findByText('detail exploded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry commit details' })).toBeInTheDocument()
  })

  it('restores the graph viewport and selection after the panel is remounted', async () => {
    const firstRender = renderPanel()
    const list = await screen.findByRole('listbox', { name: 'Commit history' })
    Object.defineProperty(list, 'scrollTop', { value: 88, writable: true })
    fireEvent.scroll(list)
    fireEvent.click(screen.getByRole('option', { name: /Build graph rows/ }))
    await waitFor(() => expect(useGitGraphStore.getState().workspaces['ws-1'].selectedCommitHash).toBe(snapshot.commits[1].hash))

    firstRender.unmount()
    renderPanel()
    const restoredList = await screen.findByRole('listbox', { name: 'Commit history' })
    await waitFor(() => expect(restoredList.scrollTop).toBe(88))
    expect(screen.getByRole('option', { name: /Build graph rows/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('explains an unborn repository instead of presenting it as a load failure', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      ...snapshot,
      capability: { isGitWorktree: true, state: 'unborn', branch: null, ref: null, headHash: null },
      commits: [],
      hasMore: false,
    })) as typeof global.fetch

    renderPanel()
    expect(await screen.findByText('This repository does not have any commits yet.')).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Commit history' })).not.toBeInTheDocument()
  })

  it('contains no repository mutation controls', async () => {
    renderPanel()
    await screen.findByRole('listbox', { name: 'Commit history' })
    for (const mutation of ['Checkout', 'Merge', 'Reset', 'Fetch', 'Push']) {
      expect(screen.queryByRole('button', { name: new RegExp(mutation, 'i') })).not.toBeInTheDocument()
    }
  })
})
