import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../src/client/i18n'
import '../../src/client/index.css'
import ContextWorkspace from '../../src/client/components/ContextWorkspace'
import { useContextTabStore } from '../../src/client/stores/context-tab-store'
import { useWorkspaceStore } from '../../src/client/stores/workspace-store'

const params = new URLSearchParams(location.search)
const workspaceId = params.get('workspace')!
const workspacePath = params.get('folder')!
await i18n.changeLanguage('en')
useWorkspaceStore.setState({ openWorkspaceIds: [workspaceId] })
useContextTabStore.getState().setContext(workspaceId, null)
useContextTabStore.getState().openGitGraph(workspaceId)

export function Fixture() {
  return <I18nextProvider i18n={i18n}>
    <button onClick={() => useContextTabStore.getState().openGitGraph(workspaceId)}>Back to graph</button>
    <div style={{ height: 'calc(100vh - 32px)', display: 'flex' }}>
      <ContextWorkspace workspaceId={workspaceId} workspacePath={workspacePath} width={window.innerWidth} isCollapsed={false} onWidthChange={() => {}} />
    </div>
  </I18nextProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
