import { createContext, useContext } from 'react'

export interface ToolRendererContextValue {
  workspacePath: string | undefined
  onOpenFile: (path: string, name: string) => void
}

const ToolRendererContext = createContext<ToolRendererContextValue>({
  workspacePath: undefined,
  onOpenFile: () => {},
})

export const ToolRendererProvider = ToolRendererContext.Provider

export function useToolRendererContext(): ToolRendererContextValue {
  return useContext(ToolRendererContext)
}
