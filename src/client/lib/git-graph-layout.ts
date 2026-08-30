export interface GitGraphLayoutCommit {
  hash: string
  parents: string[]
}

export interface GitGraphLayoutNode {
  hash: string
  row: number
  lane: number
}

export interface GitGraphLayoutEdge {
  fromHash: string
  toHash: string
  fromRow: number
  toRow: number
  fromLane: number
  toLane: number
  parentIndex: number
  clipped: boolean
}

export interface GitGraphBoundaryLane {
  hash: string
  lane: number
}

export interface GitGraphLayout {
  nodes: GitGraphLayoutNode[]
  edges: GitGraphLayoutEdge[]
  boundaryLanes: GitGraphBoundaryLane[]
  laneCount: number
}

interface PendingEdge extends Omit<GitGraphLayoutEdge, 'toRow' | 'clipped'> {}

function firstFreeLane(lanes: Array<string | null>): number {
  const free = lanes.indexOf(null)
  if (free >= 0) return free
  lanes.push(null)
  return lanes.length - 1
}

/**
 * Allocates lanes from newest to oldest. A lane contains the next commit hash
 * expected on that line, which makes the result independent of rendering and
 * stable when another page of older commits is appended.
 */
export function buildGitGraphLayout(commits: readonly GitGraphLayoutCommit[]): GitGraphLayout {
  const lanes: Array<string | null> = []
  const nodes: GitGraphLayoutNode[] = []
  const pendingEdges: PendingEdge[] = []
  let laneCount = 0

  for (const [row, commit] of commits.entries()) {
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = firstFreeLane(lanes)
      lanes[lane] = commit.hash
    }

    nodes.push({ hash: commit.hash, row, lane })

    for (const [parentIndex, parentHash] of commit.parents.entries()) {
      let parentLane = lanes.indexOf(parentHash)
      if (parentLane < 0) {
        if (parentIndex === 0) {
          parentLane = lane
        } else {
          parentLane = firstFreeLane(lanes)
        }
      }

      lanes[parentLane] = parentHash
      pendingEdges.push({
        fromHash: commit.hash,
        toHash: parentHash,
        fromRow: row,
        fromLane: lane,
        toLane: parentLane,
        parentIndex,
      })
    }

    if (commit.parents.length === 0) {
      lanes[lane] = null
    } else if (lanes[lane] === commit.hash) {
      // The first parent was already reserved by another lane, so this lane
      // has joined it and can be reused by a later branch.
      lanes[lane] = null
    }
    laneCount = Math.max(laneCount, lanes.length, lane + 1)
  }

  const nodesByHash = new Map(nodes.map((node) => [node.hash, node]))
  const boundaryRow = commits.length
  const edges = pendingEdges.map((edge): GitGraphLayoutEdge => {
    const target = nodesByHash.get(edge.toHash)
    return {
      ...edge,
      toRow: target?.row ?? boundaryRow,
      toLane: target?.lane ?? edge.toLane,
      clipped: !target,
    }
  })
  const boundaryLanes = lanes.flatMap((hash, lane) => hash ? [{ hash, lane }] : [])

  return { nodes, edges, boundaryLanes, laneCount }
}
