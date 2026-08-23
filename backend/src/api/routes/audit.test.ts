import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getPool } from '../../db/pool';
import app from '../../app';

vi.mock('../../db/pool', () => ({ getPool: vi.fn() }));

describe('GET /api/audit', () => {
  it('returns 400 when both entityType and entityId are missing', async () => {
    const res = await request(app).get('/api/audit');

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when only entityId is provided', async () => {
    const res = await request(app).get('/api/audit').query({ entityId: '5' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when only entityType is provided', async () => {
    const res = await request(app).get('/api/audit').query({ entityType: 'resolution' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when entityId is not a valid integer', async () => {
    const res = await request(app).get('/api/audit').query({ entityType: 'resolution', entityId: 'not-a-number' });

    expect(res.status).toBe(400);
  });

  it('returns audit events ordered by sequence_no, with every field kept separate', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalized.startsWith('SELECT ID, ENTITY_TYPE')) {
          expect(params).toEqual(['resolution', 5]);
          return [
            [
              {
                id: 1,
                entity_type: 'resolution',
                entity_id: 5,
                stage: 'decision_gate',
                actor_type: 'DECISION_GATE',
                evidence_used: { note: 'x' },
                ai_raw_output: null,
                decision_gate_output: { finalStatus: 'matched' },
                sequence_no: 1,
                created_at: new Date('2026-01-01'),
              },
            ],
            [],
          ];
        }
        throw new Error(`Unmocked query: ${sql}`);
      }),
    };
    vi.mocked(getPool).mockReturnValue(pool as never);

    const res = await request(app).get('/api/audit').query({ entityType: 'resolution', entityId: '5' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      entityType: 'resolution',
      entityId: 5,
      evidenceUsed: { note: 'x' },
      aiRawOutput: null,
      decisionGateOutput: { finalStatus: 'matched' },
      sequenceNo: 1,
    });
  });
});
