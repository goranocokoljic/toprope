import {describe, it, expect} from 'vitest';
import {buildSurveyQuestion} from '../../src/surveys/templates';
import {SURVEY_TRIGGER_TYPES} from '../../src/surveys/types';

describe('buildSurveyQuestion', () => {
    it('produces a question + choices for every trigger type', () => {
        for (const type of SURVEY_TRIGGER_TYPES) {
            const q = buildSurveyQuestion(type, {});
            expect(q.questionText.length).toBeGreaterThan(0);
            expect(q.choices.length).toBeGreaterThan(0);
            // Every choice has a value + label.
            for (const c of q.choices) {
                expect(c.value).toBeTruthy();
                expect(c.label).toBeTruthy();
            }
        }
    });

    it('usage_drop weaves the tool name and drop magnitude into the prompt', () => {
        const q = buildSurveyQuestion('usage_drop', {tool: 'copilot', drop_pct: -42});
        expect(q.questionText).toContain('GitHub Copilot');
        expect(q.questionText).toContain('42%');
    });

    it('usage_drop degrades gracefully when context is missing', () => {
        const q = buildSurveyQuestion('usage_drop', {});
        expect(q.questionText).toContain('an AI tool');
        expect(q.questionText.toLowerCase()).toContain('dropped');
    });

    it('unused_new_seat mentions the seat and offers a reclaim option', () => {
        const q = buildSurveyQuestion('unused_new_seat', {tool: 'cursor', days_unused: 20});
        expect(q.questionText).toContain('Cursor');
        expect(q.choices.some((c) => c.value === 'dont_need')).toBe(true);
    });

    it('plan_change describes a tool switch when old_tool is present', () => {
        const q = buildSurveyQuestion('plan_change', {tool: 'claude_code', old_tool: 'copilot'});
        expect(q.questionText).toContain('GitHub Copilot');
        expect(q.questionText).toContain('Claude Code');
    });

    it('manual uses the manager-authored question and custom choices', () => {
        const q = buildSurveyQuestion('manual', {
            question_text: 'How is the new setup?',
            choices: [
                {value: 'good', label: 'Good'},
                {value: 'bad', label: 'Bad'},
            ],
        });
        expect(q.questionText).toBe('How is the new setup?');
        expect(q.choices).toHaveLength(2);
        expect(q.choices[0]).toEqual({value: 'good', label: 'Good'});
    });

    it('framing is respectful — no accusatory wording', () => {
        const q = buildSurveyQuestion('usage_drop', {tool: 'windsurf', drop_pct: -50});
        // A light correctness check on the non-punitive copy principle.
        expect(q.questionText.toLowerCase()).not.toContain('why did you stop');
        expect(q.questionText.toLowerCase()).toContain('no problem');
    });
});
