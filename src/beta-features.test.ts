import { describe, expect, it } from 'vitest';
import {
  hasBetaFeature,
  parseBetaFeatures,
  WORKFLOW_BETA_FEATURE,
} from './beta-features';

describe('beta features', () => {
  it('matches explicit feature names exactly', () => {
    const features = parseBetaFeatures('workflow, future-feature');

    expect(hasBetaFeature(features, WORKFLOW_BETA_FEATURE)).toBe(true);
    expect(hasBetaFeature(features, 'future-feature')).toBe(true);
    expect(hasBetaFeature(features, 'WORKFLOW')).toBe(false);
    expect(hasBetaFeature(features, 'unconfigured-feature')).toBe(false);
  });

  it('treats the wildcard as enabling every beta feature', () => {
    const features = parseBetaFeatures('*');

    expect(features).toEqual(['*']);
    expect(hasBetaFeature(features, WORKFLOW_BETA_FEATURE)).toBe(true);
    expect(hasBetaFeature(features, 'future-feature')).toBe(true);
  });
});
