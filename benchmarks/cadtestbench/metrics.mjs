export function failedEvaluationFromCadtests(rows, reason = "NO_ARTIFACT") {
  const categories = {};
  const groups = new Map();
  for (const row of rows) {
    const category = row.cadtest_type || "unknown";
    categories[category] ??= { passed: 0, total: 0 };
    categories[category].total++;
    const id = row.requirement_id || `cadtest-${row.cadtest_id}`;
    if (!groups.has(id)) {
      groups.set(id, {
        requirement_id: id,
        requirement_type: row.requirement_type || "unknown",
        requirement_description: row.requirement_description || row.cadtest_description || "",
        total: 0,
        passed: 0,
        all_passed: false,
        cadtest_ids: [],
      });
    }
    const group = groups.get(id);
    group.total++;
    group.cadtest_ids.push(Number(row.cadtest_id));
  }
  return {
    passed: 0,
    total: rows.length,
    exactPass: false,
    modelCompileError: false,
    categories,
    rsGroups: [...groups.values()],
    evaluationError: reason,
  };
}

export function aggregateBenchmarkMetrics(results) {
  return {
    exact: results.filter((result) => result.evaluation?.exactPass).length,
    samples: results.length,
    scorable_samples: results.filter((result) => result.evaluation?.scorable !== false).length,
    cadtests_passed: results.reduce((sum, result) => sum + (result.evaluation?.passed ?? 0), 0),
    cadtests_total: results.reduce((sum, result) => sum + (result.evaluation?.total ?? 0), 0),
    rs_groups_passed: results.reduce(
      (sum, result) => sum + (result.evaluation?.rsGroups ?? []).filter((group) => group.all_passed).length,
      0,
    ),
    rs_groups_total: results.reduce((sum, result) => sum + (result.evaluation?.rsGroups ?? []).length, 0),
  };
}
