import type { ReactNode } from 'react'

export type ToolRenderer = (input: unknown) => ReactNode | null

export const toolRenderers = new Map<string, ToolRenderer>()

export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
  toolRenderers.set(toolName, renderer)
}

export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  return toolRenderers.get(toolName)
}

export function hasToolRenderer(toolName: string): boolean {
  return toolRenderers.has(toolName)
}
