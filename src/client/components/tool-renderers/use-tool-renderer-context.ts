import { useContext } from 'react'

import ToolRendererContext, { type ToolRendererContextValue } from './ToolRendererContext'

export function useToolRendererContext(): ToolRendererContextValue {
  return useContext(ToolRendererContext)
}
