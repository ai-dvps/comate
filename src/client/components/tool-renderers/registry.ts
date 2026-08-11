import type { ReactNode } from 'react'

export type ToolRenderer = (input: unknown) => ReactNode | null

export const toolRenderers = new Map<string, ToolRenderer>()
const securityManifestTools = new Set<string>()

export function registerToolRenderer(
  toolName: string,
  renderer: ToolRenderer,
  options?: { securityManifest?: boolean },
): void {
  toolRenderers.set(toolName, renderer)
  if (options?.securityManifest) securityManifestTools.add(toolName)
  else securityManifestTools.delete(toolName)
}

export function getToolRenderer(toolName: string): ToolRenderer | undefined {
  return toolRenderers.get(toolName)
}

export function hasToolRenderer(toolName: string): boolean {
  return toolRenderers.has(toolName)
}

export function isSecurityManifestRenderer(toolName: string): boolean {
  return securityManifestTools.has(toolName)
}
