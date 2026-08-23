import { describe, expect, it } from 'vitest';
import { buildEvidenceBundle } from './evidenceBundle';
import { LedgerOrder, Settlement } from '../matching/types';
import { RoutedCase } from '../matching/thresholdGate';

function makeSettlement(overrides: Partial<Settlement> & { id: number }): Settlement {
  return {
    entityId: `pay_secret_${overrides.id}`,
    orderId: `order_secret_${overrides.id}`,
    amount: 1000,
    fee: 20,
    tax: 4,
    settlementUtr: `UTRSECRET${overrides.id}`,
    creditType: 'default',
    hasDispute: false,
    narration: null,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<LedgerOrder> & { id: number }): LedgerOrder {
  return {
    orderId: `order_secret_${overrides.id}`,
    expectedAmount: 1000,
    expectedDate: null,
    ...overrides,
  };
}

describe('buildEvidenceBundle', () => {
  it('never leaks a real settlement/order id anywhere in the JSON-stringified bundle', () => {
    const order = makeOrder({ id: 999 });
    const s1 = makeSettlement({ id: 501, narration: 'Retry after timeout' });
    const s2 = makeSettlement({ id: 502, narration: 'Confirmed original' });

    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [s1, s2],
      order,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'multiple_settlements_same_order_same_amount_no_discriminating_signal',
    };

    const { bundle } = buildEvidenceBundle(routedCase);
    const json = JSON.stringify(bundle);

    const secrets = [
      s1.entityId,
      s2.entityId,
      s1.orderId,
      s2.orderId,
      s1.settlementUtr as string,
      s2.settlementUtr as string,
      order.orderId,
      String(s1.id),
      String(s2.id),
      String(order.id),
    ];

    for (const secret of secrets) {
      expect(json.includes(secret)).toBe(false);
    }
  });

  it('assigns tokens in stable ascending settlement.id order regardless of input array order', () => {
    const order = makeOrder({ id: 1 });
    const sHigh = makeSettlement({ id: 20 });
    const sLow = makeSettlement({ id: 10 });

    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [sHigh, sLow], // deliberately out of id order
      order,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };

    const { bundle, tokenToSettlementId } = buildEvidenceBundle(routedCase);

    expect(bundle.candidates[0].token).toBe('CANDIDATE_A');
    expect(bundle.candidates[1].token).toBe('CANDIDATE_B');
    expect(tokenToSettlementId.get('CANDIDATE_A')).toBe(10); // lower id first
    expect(tokenToSettlementId.get('CANDIDATE_B')).toBe(20);
  });

  it('only includes allow-listed fields on each candidate', () => {
    const s = makeSettlement({ id: 1, creditType: 'default', hasDispute: true, narration: 'note' });

    const routedCase: RoutedCase = {
      caseType: 'residual_no_match',
      settlements: [s],
      order: null,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'no_viable_candidate_in_component',
    };

    const { bundle } = buildEvidenceBundle(routedCase);

    expect(bundle.orderContext).toBeNull();
    expect(Object.keys(bundle.candidates[0]).sort()).toEqual(
      ['token', 'amount', 'fee', 'tax', 'creditType', 'hasDispute', 'narration'].sort(),
    );
  });

  it('populates orderContext with only expectedAmount and currency when an order exists', () => {
    const order = makeOrder({ id: 42, expectedAmount: 55555 });
    const s = makeSettlement({ id: 1 });

    const routedCase: RoutedCase = {
      caseType: 'ambiguous_duplicate',
      settlements: [s],
      order,
      fsScore: null,
      route: 'ai_investigation',
      reasonCode: 'x',
    };

    const { bundle } = buildEvidenceBundle(routedCase);

    expect(bundle.orderContext).toEqual({ expectedAmount: 55555, currency: 'INR' });
  });

  it('throws for a case not routed to ai_investigation', () => {
    const order = makeOrder({ id: 1 });
    const s = makeSettlement({ id: 1 });
    const routedCase: RoutedCase = {
      caseType: 'exact_match',
      settlements: [s],
      order,
      fsScore: null,
      route: 'auto_resolve',
      reasonCode: 'exact_id_and_amount_match',
    };

    expect(() => buildEvidenceBundle(routedCase)).toThrow();
  });
});
