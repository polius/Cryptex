/** The code a request shows on both sides (flows/request.ts). */
import { describe, expect, it } from 'vitest';
import { requestCode } from './request';

describe('requestCode', () => {
  it('is the same for an ID every time, readable, and differs between IDs', () => {
    expect(requestCode('XD4FCVURV9')).toBe(requestCode('XD4FCVURV9'));
    expect(requestCode('XD4FCVURV9')).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/); // no I, L, O or U
    const codes = new Set(Array.from({ length: 2000 }, (_, i) => requestCode(`k7Qp2vR${String(i).padStart(3, '0')}`)));
    expect(codes.size).toBe(2000);
  });
});
