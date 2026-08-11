import { describe, expect, it } from 'vitest'
import { BROWSER_TOOL_NAMES } from '@server/services/browser-tool-names'
import { getToolRenderer, isSecurityManifestRenderer } from './registry'
import './renderers/BrowserSubmitRenderer'
import './renderers/BrowserActivationRenderer'
import './renderers/BrowserUploadRenderer'

describe('security manifest renderer registry', () => {
  it('keeps submit, activation, and upload manifests non-collapsible without browser branching', () => {
    for (const toolName of [BROWSER_TOOL_NAMES.submit, BROWSER_TOOL_NAMES.activate, BROWSER_TOOL_NAMES.upload]) {
      expect(getToolRenderer(toolName)).toBeTypeOf('function')
      expect(isSecurityManifestRenderer(toolName)).toBe(true)
    }
    expect(isSecurityManifestRenderer('Read')).toBe(false)
  })
})
