import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import {
  Conversation,
  ConversationContent,
} from './conversation'

describe('Conversation', () => {
  it('does not add overflow-y-auto on the outer wrapper to avoid nested scrollbars', () => {
    const { container } = render(
      <Conversation>
        <ConversationContent>
          <div>message</div>
        </ConversationContent>
      </Conversation>,
    )

    const outer = container.firstChild as HTMLElement
    expect(outer).toHaveClass('overflow-hidden')
    expect(outer).not.toHaveClass('overflow-y-auto')
  })
})
