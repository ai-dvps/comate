import { describe, it, expect } from 'vitest'
import { TrigramCompletion, tokenize } from '../lib/ngram-completion'

describe('tokenize', () => {
  it('splits Latin runs into word tokens', () => {
    expect(tokenize('Explain the function')).toEqual([
      'explain',
      'the',
      'function',
    ])
  })

  it('splits CJK runs into individual characters', () => {
    expect(tokenize('解释这个函数')).toEqual(['解', '释', '这', '个', '函', '数'])
  })

  it('does not cross run boundaries', () => {
    expect(tokenize('解释这个 authLogin 函数')).toEqual([
      '解', '释', '这', '个',
      'authlogin',
      '函', '数',
    ])
  })
})

describe('TrigramCompletion', () => {
  it('suggests the next word from a learned trigram', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    model.train('explain the class')
    expect(model.suggest('explain the ')).toBe('function')
  })

  it('falls back to bigram when trigram is absent', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    expect(model.suggest('the ')).toBe('function')
  })

  it('prepends a space for Latin continuation when input lacks trailing whitespace', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    expect(model.suggest('explain')).toBe(' the')
  })

  it('returns null when confidence is too low', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the class')
    expect(model.suggest('explain the ')).toBeNull()
  })

  it('returns null for untrained input', () => {
    const model = new TrigramCompletion()
    expect(model.suggest('hello ')).toBeNull()
  })

  it('trains CJK prompts with character-level tokens', () => {
    const model = new TrigramCompletion()
    model.train('解释这个函数')
    model.train('解释这个函数')
    expect(model.suggest('解释这个')).toBe('函')
  })

  it('clears learned data', () => {
    const model = new TrigramCompletion()
    model.train('explain the function')
    model.train('explain the function')
    model.clear()
    expect(model.suggest('explain the ')).toBeNull()
  })
})
