import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

function tsxFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) return tsxFiles(entryPath)
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return []
    return [entryPath]
  })
}

test('every aria-labeled icon button has hover information', () => {
  const missingTitles: string[] = []

  for (const file of tsxFiles(path.join(process.cwd(), 'src/client'))) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )

    const visit = (node: ts.Node, insideTooltipTrigger = false) => {
      const hasTooltip = insideTooltipTrigger || (
        ts.isJsxElement(node)
        && node.openingElement.tagName.getText(sourceFile) === 'TooltipTrigger'
      )

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const openingElement = ts.isJsxElement(node) ? node.openingElement : node
        const tagName = openingElement.tagName.getText(sourceFile)
        if (tagName === 'button' || tagName.endsWith('Button')) {
          const attributes = openingElement.attributes.properties
          const names = new Set(
            attributes.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(sourceFile)),
          )
          if (names.has('aria-label') && !names.has('title') && !hasTooltip) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            missingTitles.push(`${path.relative(process.cwd(), file)}:${line + 1}`)
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, hasTooltip))
    }

    visit(sourceFile)
  }

  assert.deepEqual(missingTitles, [])
})
