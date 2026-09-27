import { describe, expect, it } from 'vitest'
import { buildGitGraphLayout } from './git-graph-layout'
import type { GitGraphCommit } from '../stores/git-graph-store'

function commit(hash: string, parents: string[] = []): GitGraphCommit {
  return {
    hash,
    shortHash: hash,
    parents,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: '2026-08-30T00:00:00.000Z',
    subject: hash,
    refs: [],
    isHead: false,
  }
}

describe('buildGitGraphLayout', () => {
  it('keeps linear first-parent history in one lane', () => {
    const layout = buildGitGraphLayout([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a'),
    ])

    expect(layout.nodes.map(({ hash, row, lane }) => ({ hash, row, lane }))).toEqual([
      { hash: 'c', row: 0, lane: 0 },
      { hash: 'b', row: 1, lane: 0 },
      { hash: 'a', row: 2, lane: 0 },
    ])
    expect(layout.edges).toEqual([
      expect.objectContaining({ fromHash: 'c', toHash: 'b', fromLane: 0, toLane: 0, clipped: false }),
      expect.objectContaining({ fromHash: 'b', toHash: 'a', fromLane: 0, toLane: 0, clipped: false }),
    ])
  })

  it('opens an alternate lane for a merge and reconnects it deterministically', () => {
    const commits = [
      commit('merge', ['main', 'topic']),
      commit('main', ['base']),
      commit('topic', ['base']),
      commit('base'),
    ]
    const layout = buildGitGraphLayout(commits)

    expect(layout.nodes.map(({ hash, lane }) => ({ hash, lane }))).toEqual([
      { hash: 'merge', lane: 0 },
      { hash: 'main', lane: 0 },
      { hash: 'topic', lane: 1 },
      { hash: 'base', lane: 0 },
    ])
    expect(layout.edges.find((edge) => edge.fromHash === 'merge' && edge.toHash === 'topic'))
      .toEqual(expect.objectContaining({ fromLane: 0, toLane: 1, parentIndex: 1 }))
    expect(buildGitGraphLayout(commits)).toEqual(layout)
  })

  it('supports octopus parents and clips parents outside the loaded window', () => {
    const layout = buildGitGraphLayout([
      commit('merge', ['p1', 'p2', 'p3']),
      commit('p1', ['old-main']),
      commit('p2', ['old-topic']),
      commit('p3', ['old-third']),
    ])

    expect(layout.nodes.map((node) => node.lane)).toEqual([0, 0, 1, 2])
    expect(layout.edges.filter((edge) => edge.clipped).map((edge) => edge.toHash).sort())
      .toEqual(['old-main', 'old-third', 'old-topic'])
    expect(layout.boundaryLanes).toEqual([
      { hash: 'old-main', lane: 0 },
      { hash: 'old-topic', lane: 1 },
      { hash: 'old-third', lane: 2 },
    ])
  })

  it('keeps the existing node lanes and edge origins stable when history expands', () => {
    const prefix = [commit('c', ['b']), commit('b', ['a'])]
    const before = buildGitGraphLayout(prefix)
    const after = buildGitGraphLayout([...prefix, commit('a', ['root']), commit('root')])

    expect(after.nodes.slice(0, prefix.length)).toEqual(before.nodes)
    expect(after.edges.slice(0, 2).map(({ fromHash, toHash, fromLane, toLane }) => ({
      fromHash, toHash, fromLane, toLane,
    }))).toEqual(before.edges.map(({ fromHash, toHash, fromLane, toLane }) => ({
      fromHash, toHash, fromLane, toLane,
    })))
  })
})
