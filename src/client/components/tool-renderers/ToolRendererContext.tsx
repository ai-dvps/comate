import { createContext } from 'react'

export interface ToolRendererContextValue {
  workspacePath: string | undefined
  onOpenFile: (path: string, name: string) => void
}

const ToolRendererContext = createContext<ToolRendererContextValue>({
  workspacePath: undefined,
  onOpenFile: () => {},
})

export const ToolRendererProvider = ToolRendererContext.Provider
export default ToolRendererContext
