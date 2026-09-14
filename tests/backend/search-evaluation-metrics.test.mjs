import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conditionPlanCorrect,
  rankingMetrics
} from '../fixtures/search-metrics.mjs'
test('plan evaluation ignores JSON key order and commuting AND but preserves scope, exclusion and year bounds', () => {
  const expected = {
    must: [
      { kind: 'filter', field: 'years', op: 'lte', value: 3 },
      { kind: 'term', text: 'Unity', match: 'concept', evidence_scope: 'self' }
    ],
    must_not: []
  }
  const model = {
    must: [
      {
        kind: 'all',
        scope: 'candidate',
        children: [
          {
            span: [0, 5],
            text: 'Unity',
            evidence_scope: 'self',
            match: 'concept',
            kind: 'term'
          },
          { value: 3, op: 'lte', field: 'years', kind: 'filter', span: [6, 7] }
        ]
      }
    ],
    must_not: [],
    should: [],
    minimum_should_match: 0,
    unresolved: []
  }
  assert.equal(conditionPlanCorrect(model, expected), true)
  model.must[0].children[1].op = 'gte'
  assert.equal(conditionPlanCorrect(model, expected), false)
  model.must[0].children[1].op = 'lte'
  model.must[0].scope = 'record'
  assert.equal(conditionPlanCorrect(model, expected), false)
})
test('metrics keep missing Precision slots and mark no-positive ranking queries N/A', () => {
  assert.deepEqual(rankingMetrics(['wrong', 'a'], ['a', 'b']), {
    recall50: 0.5,
    precision10: 0.1,
    ndcg10: 1 / Math.log2(3) / (1 + 1 / Math.log2(3)),
    mrr: 0.5,
    zero_result_correct: null
  })
  assert.deepEqual(rankingMetrics([], []), {
    recall50: null,
    precision10: 0,
    ndcg10: null,
    mrr: null,
    zero_result_correct: true
  })
})
