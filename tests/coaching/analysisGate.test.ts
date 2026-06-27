import {describe, it, expect} from 'vitest';
import {selectGatedAnalyzer, type AnalyzerPair} from '../../src/coaching/analysisGate';
import type {AnalysisLocation} from '../../src/coaching/retrospective/types';

/** Minimal analyser stubs — the gate only inspects `location`. */
const local = {location: 'local' as const, model: 'local-x'};
const cloud = {location: 'cloud' as const, model: 'cloud-x'};

type Stub = {readonly location: AnalysisLocation; readonly model: string};

function pair(withCloud: boolean): AnalyzerPair<Stub> {
    return withCloud ? {local, cloud} : {local};
}

describe('selectGatedAnalyzer — shared deep-coaching cloud gate', () => {
    it('returns the local analyser for an explicit local request', () => {
        const r = selectGatedAnalyzer('local', false, pair(true));
        expect(r).toEqual({analyzer: local});
    });

    it('returns the cloud analyser only when cloud is allowed AND configured', () => {
        const r = selectGatedAnalyzer('cloud', true, pair(true));
        expect(r).toEqual({analyzer: cloud});
    });

    it('refuses cloud (cloud_not_allowed) when the permission is not granted', () => {
        const r = selectGatedAnalyzer('cloud', false, pair(true));
        expect('error' in r && r.error.code).toBe('cloud_not_allowed');
    });

    it('refuses cloud (cloud_not_configured) when allowed but no cloud analyser exists', () => {
        const r = selectGatedAnalyzer('cloud', true, pair(false));
        expect('error' in r && r.error.code).toBe('cloud_not_configured');
    });

    it('is FAIL-CLOSED: an unknown/garbled location can never pick cloud — it falls through to local', () => {
        // Simulate a future enum widening / corrupt value reaching the gate. The
        // inverted branch (only `cloud` is named) must resolve anything else to local,
        // even when cloud is fully permitted and configured.
        const garbage = 'martian' as unknown as AnalysisLocation;
        const r = selectGatedAnalyzer(garbage, true, pair(true));
        expect(r).toEqual({analyzer: local});
    });
});
