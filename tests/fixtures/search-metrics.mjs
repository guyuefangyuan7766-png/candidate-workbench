function canonical(node) {
  if (Array.isArray(node)) return node.map(canonical)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(
    Object.keys(node)
      .filter((key) => key !== 'span')
      .sort()
      .map((key) => {
        const value = canonical(node[key])
        return [
          key,
          key === 'children'
            ? value.sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b))
              )
            : value
        ]
      })
  )
}
function shapes(nodes) {
  const flattened = nodes.flatMap((node) =>
    node.kind === 'all' && node.scope === 'candidate'
      ? JSON.parse(shapes(node.children))
      : [canonical(node)]
  )
  return JSON.stringify(
    flattened.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  )
}
export function conditionPlanCorrect(plan, expected) {
  return (
    shapes(plan.must) === shapes(expected.must) &&
    shapes(plan.must_not) === shapes(expected.must_not ?? []) &&
    plan.should.length === 0 &&
    plan.minimum_should_match === 0 &&
    plan.unresolved.length === 0
  )
}
export function rankingMetrics(ids, expected) {
  const set = new Set(expected)
  const rel = ids.map((id) => (set.has(id) ? 1 : 0))
  const dcg = rel
    .slice(0, 10)
    .reduce((sum, r, i) => sum + r / Math.log2(i + 2), 0)
  const ideal = Array.from(
    { length: Math.min(10, set.size) },
    (_, i) => 1 / Math.log2(i + 2)
  ).reduce((a, b) => a + b, 0)
  return {
    recall50: set.size
      ? rel.slice(0, 50).reduce((a, b) => a + b, 0) / set.size
      : null,
    precision10: rel.slice(0, 10).reduce((a, b) => a + b, 0) / 10,
    ndcg10: ideal ? dcg / ideal : null,
    mrr: set.size ? (rel.indexOf(1) < 0 ? 0 : 1 / (rel.indexOf(1) + 1)) : null,
    zero_result_correct: set.size ? null : ids.length === 0
  }
}
