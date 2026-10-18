import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { I18nextProvider } from 'react-i18next'
import '../index.css'
import i18n from '../i18n'
import { useChatStore } from '../stores/chat-store'
import ApprovalSurface from './ApprovalSurface'
import BackgroundTaskList from './BackgroundTaskList'
import SessionTokenUsage from './SessionTokenUsage'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  await page.viewport(1280, 900)
})

it('keeps constrained approvals and task/context diagnostics usable at desktop and narrow widths', async () => {
  await i18n.changeLanguage('zh-CN')
  useChatStore.setState({ contextUsage: { 'preview-session': {
    detail: 'summary', totalTokens: 12000, maxTokens: 100000, percentage: 12,
    categories: [
      { name: '对话内容', tokens: 12000, kind: 'used' },
      { name: '压缩预留', tokens: 20000, kind: 'buffer' },
      { name: '可用空间', tokens: 68000, kind: 'free' },
      { name: '未载入工具', tokens: 40000, kind: 'deferred' },
    ],
  } } })
  const onAllow = vi.fn()
  const noop = () => {}
  render(<I18nextProvider i18n={i18n}><main className="mx-auto flex max-w-xl flex-col gap-6 p-4 text-text-primary">
    <ApprovalSurface workspaceId="preview-workspace" sessionId="preview-session" queueDepth={0} isResolving={false}
      pendingItem={{ requestId: 'restricted', toolUseId: 'tool', toolName: 'Bash', input: { command: 'git status' }, inputSummary: 'git status',
        defaultToNo: true, suppressAlwaysAllowRule: true,
        suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }}
      onAllow={onAllow} onAllowAlways={noop} onDeny={noop} onDecideLater={noop} onAnswerQuestion={noop} onChatAbout={noop} onStop={noop} />
    <section className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <h2>后台工作</h2>
      <BackgroundTaskList supportsStop typeLabel={() => '子任务'} isStopping={() => false} onStop={noop}
        tasks={[
          { id: 'child', parentTaskId: 'parent', type: 'agent', runId: 'b', subagentType: '研究助手', description: '整理资料并检查引用来源' },
          { id: 'parent', type: 'agent', description: '分析项目升级与兼容影响' },
          { id: 'watcher', type: 'monitor', description: '关注本地文件更新', ambient: true },
        ]} />
    </section>
    <SessionTokenUsage sessionId="preview-session" />
  </main></I18nextProvider>)
  expect(screen.getByRole('button', { name: '拒绝' })).toHaveFocus()
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
  expect(onAllow).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '始终允许' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('维护任务（1）'))
  await page.viewport(1280, 900)
  fireEvent.click(screen.getByRole('button', { name: '上下文: 12%' }))
  expect(await screen.findByText(/摘要估算/)).toBeVisible()
  await page.screenshot({ path: '/tmp/comate-claude-enhancements-desktop.png' })
  await page.viewport(390, 844)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  expect(screen.getByRole('button', { name: '拒绝' })).toBeVisible()
  await page.screenshot({ path: '/tmp/comate-claude-enhancements-narrow.png' })
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await page.screenshot({ path: '/tmp/comate-claude-tasks-narrow.png' })
})
