import {describe, expect, it} from 'vitest';
import {formatOverviewValue, parseOverview} from '../../src/features/overview/overview';

import {canonicalFixture} from './fixtures';

describe('workspace overview contracts', () => {
  it('preserves exact recorded amount values without asserting provider settlement', () => {
    const result = parseOverview(canonicalFixture(), 'canonical_evidence_ledger');
    const amount = result.metrics.find((entry) => entry.key === 'total_net_contributions_rwf');
    expect(amount).toBeDefined();
    expect(formatOverviewValue(amount!)).toBe('RWF 9,007,199,254,740,993');
  });

  it('rejects a changed financial basis or inconsistent metric', () => {
    const invalid = canonicalFixture();
    invalid.contribution_basis = 'settled';
    expect(() => parseOverview(invalid, 'canonical_evidence_ledger')).toThrow(/could not be verified/);
    const mismatch = canonicalFixture();
    mismatch.metrics[0].value = '999';
    expect(() => parseOverview(mismatch, 'canonical_evidence_ledger')).toThrow(/could not be verified/);
  });
});
