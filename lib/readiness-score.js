const { config } = require("./rubric");
const wordCount = text => (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;

function computeScores(rubric, parameters, verifiedFindings, baseline, unverifiedFindings = []) {
  const penalties = verifiedFindings.map(finding => {
    const severityPoints = config.severity_points[finding.severity];
    const confidencePercent = config.confidence_percent[finding.confidence];
    const coveragePercent = config.coverage_percent[finding.prompt_coverage];
    // Exact integer hundredths avoid floating-point drift and premature per-item rounding.
    const penaltyHundredths = severityPoints * confidencePercent * coveragePercent / 100;
    return {
      findingId: finding.id, parameterId: finding.parameter_id, theme: finding.theme, verified: true,
      penalty: Math.round(penaltyHundredths / 100), penaltyHundredths,
      formulaInputs: {
        severity: finding.severity, severityPoints, confidence: finding.confidence,
        confidencePercent, confidenceMultiplier: String(confidencePercent / 100),
        promptCoverage: finding.prompt_coverage, coveragePercent, coverageMultiplier: String(coveragePercent / 100),
      },
    };
  });
  for (const finding of unverifiedFindings) penalties.push({
    findingId: finding.id, parameterId: finding.parameter_id, theme: finding.theme, verified: false,
    penalty: 0, penaltyHundredths: 0, formulaInputs: null, excludedReasons: finding.unverifiedReasons,
  });
  const themeCalculations = config.themes.map(theme => {
    const themeParameters = parameters.filter(parameter => parameter.theme === theme.id);
    const observed = themeParameters.filter(parameter => parameter.observed).length;
    const penaltyHundredths = penalties.filter(penalty => penalty.theme === theme.id).reduce((sum, penalty) => sum + penalty.penaltyHundredths, 0);
    const scoreHundredths = Math.max(0, 10000 - penaltyHundredths);
    return {
      ...theme, weight: rubric.weights[theme.id], assessed: observed > 0,
      score: observed ? Math.round(scoreHundredths / 100) : null,
      status: observed ? "Assessed" : "Not assessed in this excerpt",
      observedParameters: observed, totalParameters: themeParameters.length,
      penalty: Math.round(penaltyHundredths / 100), penaltyHundredths,
      scoreHundredths,
    };
  });
  const assessed = themeCalculations.filter(theme => theme.assessed);
  const assessedWeightTotal = assessed.reduce((sum, theme) => sum + theme.weight, 0);
  const sufficient = assessed.length >= config.minimum_assessed_themes;
  const safetyCriticalGap = verifiedFindings.some(finding => finding.severity === "critical" && ["none", "partial"].includes(finding.prompt_coverage));
  const beforeCap = sufficient
    ? Math.round(assessed.reduce((sum, theme) => sum + theme.scoreHundredths * theme.weight, 0) / assessedWeightTotal / 100)
    : null;
  const overall = beforeCap === null ? null : safetyCriticalGap ? Math.min(beforeCap, config.safety_cap) : beforeCap;
  const provisional = !!baseline.outputPartial || baseline.status !== "finished";
  return {
    name: "Prompt readiness score (model-assessed)",
    overall, band: overall === null ? null : config.bands.find(band => overall >= band.minimum).label,
    provisional, safetyCriticalGap, capApplied: overall !== null && overall < beforeCap,
    flags: safetyCriticalGap ? ["Safety-critical gap"] : [],
    assessedThemes: assessed.length, assessedWeightTotal,
    noOverallReason: sufficient ? null : "Fewer than two themes were assessed in this excerpt.",
    themes: themeCalculations.map(({ scoreHundredths, ...theme }) => ({
      ...theme, effectiveWeight: theme.assessed ? `${theme.weight}/${assessedWeightTotal}` : null,
    })),
    penalties,
    evidenceCoverage: {
      excerptLengthMs: Math.round((baseline.progress?.audioSecondsTotal || 0) * 1000),
      excerptLength: `${baseline.progress?.audioSecondsTotal || 0}s`,
      wordCount: wordCount(baseline.rawOutput),
      parametersObserved: parameters.filter(parameter => parameter.observed).length,
      parametersTotal: parameters.length,
      transcriptStatus: provisional ? "partial" : "final",
    },
    unavailable: { wordAccuracy: "Unavailable", taskCompletion: "Unavailable", accessibility: "Unavailable" },
    calculation: "Severity points × confidence multiplier × coverage multiplier. Exact penalties are accumulated before theme and overall scores are rounded to whole numbers. Only observed themes enter the weighted average. A verified critical finding with none or partial coverage caps the overall score at 55.",
  };
}

module.exports = { computeScores, wordCount };
