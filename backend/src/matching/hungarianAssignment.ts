// Hungarian assignment (Kuhn-Munkres) over a single ambiguity component,
// implemented from scratch. Components are expected to be small (well under
// 20 nodes per side), so a self-contained O(n^3) implementation is both
// fast enough and easier to reason about/justify than pulling in an
// external assignment-problem package for this one call site.

import { Component } from './ambiguityComponents';
import { LedgerOrder, Settlement } from './types';

export interface AssignmentResult {
  settlement: Settlement;
  order: LedgerOrder | null; // null means Hungarian assigned this settlement to a dummy "no match" slot
  fsScore: number | null;
}

// Any real settlement <-> dummy edge, or any real settlement <-> real order
// pair with no qualifying candidate at all, is treated as "no viable match" -
// a cost so bad that Hungarian only ever picks it when every real option in
// the component scored worse than having no match at all, never as an
// arbitrary tie-break.
const DUMMY_FS_SCORE = -1e9;

/**
 * Solves the square minimum-cost perfect-matching problem via the
 * classical O(n^3) Hungarian algorithm (successive shortest augmenting
 * paths with vertex potentials). `cost` must be n x n. Returns
 * `assignment[row] = column` (both 0-indexed).
 */
function solveMinCostAssignment(cost: number[][]): number[] {
  const n = cost.length;

  // 1-indexed internal arrays (the standard formulation of this algorithm),
  // translated back to 0-indexed results at the end.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const rowAssignedToCol = new Array<number>(n + 1).fill(0); // rowAssignedToCol[col] = row (1-indexed), 0 = none
  const parentCol = new Array<number>(n + 1).fill(0);

  for (let row = 1; row <= n; row++) {
    rowAssignedToCol[0] = row;
    let col0 = 0;
    const minCostToCol = new Array<number>(n + 1).fill(Infinity);
    const colVisited = new Array<boolean>(n + 1).fill(false);

    do {
      colVisited[col0] = true;
      const curRow = rowAssignedToCol[col0];
      let delta = Infinity;
      let nextCol = -1;

      for (let col = 1; col <= n; col++) {
        if (!colVisited[col]) {
          const reducedCost = cost[curRow - 1][col - 1] - u[curRow] - v[col];
          if (reducedCost < minCostToCol[col]) {
            minCostToCol[col] = reducedCost;
            parentCol[col] = col0;
          }
          if (minCostToCol[col] < delta) {
            delta = minCostToCol[col];
            nextCol = col;
          }
        }
      }

      for (let col = 0; col <= n; col++) {
        if (colVisited[col]) {
          u[rowAssignedToCol[col]] += delta;
          v[col] -= delta;
        } else {
          minCostToCol[col] -= delta;
        }
      }

      col0 = nextCol;
    } while (rowAssignedToCol[col0] !== 0);

    // Walk the augmenting path back, flipping assignments.
    let col = col0;
    while (col !== 0) {
      const parent = parentCol[col];
      rowAssignedToCol[col] = rowAssignedToCol[parent];
      col = parent;
    }
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let col = 1; col <= n; col++) {
    if (rowAssignedToCol[col] !== 0) {
      assignment[rowAssignedToCol[col] - 1] = col - 1;
    }
  }
  return assignment;
}

export function assignComponent(component: Component): AssignmentResult[] {
  const { settlements, orders, edges } = component;

  const scoreByPairKey = new Map<string, number>();
  for (const edge of edges) {
    scoreByPairKey.set(`${edge.settlement.id}:${edge.order.id}`, edge.fsScore);
  }

  const n = settlements.length;
  const m = orders.length;
  const size = Math.max(n, m, 1);

  // Build the square cost matrix (minimize cost = -fsScore, so maximizing FS
  // score = minimizing cost). Padding rows/cols beyond n/m are dummy nodes;
  // real pairs with no qualifying edge get the same treatment as a dummy.
  const cost: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row: number[] = [];
    for (let j = 0; j < size; j++) {
      const isRealPair = i < n && j < m;
      const fsScore = isRealPair ? scoreByPairKey.get(`${settlements[i].id}:${orders[j].id}`) : undefined;
      row.push(-(fsScore ?? DUMMY_FS_SCORE));
    }
    cost.push(row);
  }

  const assignment = solveMinCostAssignment(cost);

  const results: AssignmentResult[] = [];
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    const key = j >= 0 && j < m ? `${settlements[i].id}:${orders[j].id}` : undefined;
    const fsScore = key ? scoreByPairKey.get(key) : undefined;

    if (fsScore === undefined) {
      // Assigned to a padded dummy column, or to a real order slot with no
      // qualifying edge (both cost DUMMY_FS_SCORE) - either way, no viable
      // match was found for this settlement in this component.
      results.push({ settlement: settlements[i], order: null, fsScore: null });
    } else {
      results.push({ settlement: settlements[i], order: orders[j], fsScore });
    }
  }

  return results;
}
