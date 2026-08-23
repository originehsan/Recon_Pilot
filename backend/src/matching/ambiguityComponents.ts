// Connected-component detection over the bipartite settlement/order graph
// formed by candidates whose FS score clears the review-band floor. Each
// component is later handed to Hungarian assignment (assignComponent) in
// isolation.

import { CandidatePair, LedgerOrder, Settlement } from './types';

export interface Component {
  settlements: Settlement[];
  orders: LedgerOrder[];
  edges: { settlement: Settlement; order: LedgerOrder; fsScore: number }[];
}

// Disjoint-set (union-find) with path compression, keyed by a type-prefixed
// string id so settlement ids and order ids can never collide with each
// other in the same node space.
class UnionFind {
  private readonly parent = new Map<string, string>();

  private root(node: string): string {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }

    let current = node;
    while (this.parent.get(current) !== current) {
      current = this.parent.get(current)!;
    }

    // Path compression.
    let walker = node;
    while (this.parent.get(walker) !== current) {
      const next = this.parent.get(walker)!;
      this.parent.set(walker, current);
      walker = next;
    }

    return current;
  }

  union(a: string, b: string): void {
    const rootA = this.root(a);
    const rootB = this.root(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }

  find(node: string): string {
    return this.root(node);
  }
}

const settlementKey = (s: Settlement): string => `s:${s.id}`;
const orderKey = (o: LedgerOrder): string => `o:${o.id}`;

/**
 * Nodes are distinct settlements/orders that appear in at least one
 * candidate pair with fsScore >= lowerThreshold (inclusive); edges are
 * exactly those qualifying pairs. A settlement or order with zero
 * qualifying edges appears in no component at all - the caller (the
 * pipeline wiring in Step 7) is responsible for routing those separately.
 */
export function findAmbiguityComponents(
  scoredCandidates: (CandidatePair & { fsScore: number })[],
  lowerThreshold: number,
): Component[] {
  const qualifyingEdges = scoredCandidates.filter((c) => c.fsScore >= lowerThreshold);

  const unionFind = new UnionFind();
  for (const edge of qualifyingEdges) {
    unionFind.union(settlementKey(edge.settlement), orderKey(edge.order));
  }

  interface Building {
    settlements: Map<string, Settlement>;
    orders: Map<string, LedgerOrder>;
    edges: Component['edges'];
  }

  const componentsByRoot = new Map<string, Building>();

  for (const edge of qualifyingEdges) {
    const root = unionFind.find(settlementKey(edge.settlement));

    let building = componentsByRoot.get(root);
    if (!building) {
      building = { settlements: new Map(), orders: new Map(), edges: [] };
      componentsByRoot.set(root, building);
    }

    building.settlements.set(settlementKey(edge.settlement), edge.settlement);
    building.orders.set(orderKey(edge.order), edge.order);
    building.edges.push({ settlement: edge.settlement, order: edge.order, fsScore: edge.fsScore });
  }

  return Array.from(componentsByRoot.values()).map((building) => ({
    settlements: Array.from(building.settlements.values()),
    orders: Array.from(building.orders.values()),
    edges: building.edges,
  }));
}
