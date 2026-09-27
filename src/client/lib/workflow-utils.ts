import type { WorkflowState, WorkflowProgressAgent, WorkflowProgressPhase } from '../types/message'

export function getCurrentPhaseTitle(workflow: WorkflowState): string | undefined {
  const phaseIndex = getWorkflowPhaseIndex(workflow)
  if (phaseIndex >= 0 && workflow.phases[phaseIndex]) {
    return workflow.phases[phaseIndex].title
  }
  const phaseProgress = workflow.progress.filter(
    (p): p is WorkflowProgressPhase => p.type === 'workflow_phase',
  )
  if (phaseProgress.length > 0) {
    return phaseProgress[phaseProgress.length - 1]?.title
  }
  return workflow.phases[0]?.title
}

export function getWorkflowPhaseIndex(workflow: WorkflowState): number {
  const phaseProgress = workflow.progress.filter(
    (p): p is WorkflowProgressPhase => p.type === 'workflow_phase',
  )
  if (phaseProgress.length === 0) return -1
  return phaseProgress[phaseProgress.length - 1]?.index ?? -1
}

export function getSubagentCounts(workflow: WorkflowState): {
  completed: number
  running: number
  total: number
} {
  const agentProgress = workflow.progress.filter(
    (p): p is WorkflowProgressAgent => p.type === 'workflow_agent',
  )
  if (agentProgress.length > 0) {
    const completed = agentProgress.filter((p) => p.state === 'done').length
    const running = agentProgress.filter((p) => p.state === 'running').length
    return { completed, running, total: agentProgress.length }
  }

  const total = workflow.agentCount ?? workflow.subagents.length
  const completed = workflow.subagents.filter((s) => s.state === 'completed').length
  const running = workflow.subagents.filter((s) => s.state === 'running').length
  return { completed, running, total }
}
