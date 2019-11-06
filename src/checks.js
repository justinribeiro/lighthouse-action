'use strict';

const {getCustomLighthouseScoringBudget} = require('./config');

function getOverBudgetItems(lhr) {
  const budget = lhr.audits['performance-budget'];

  if (
    !budget.details ||
    !budget.details.items ||
    !budget.details.items.some(item => item.sizeOverBudget)
  ) {
    return [];
  }
  return budget.details.items;
}

function getScoreBudgetItems(lhr, budgetItems) {
  const results = [];
  for (const [key, {score, numericValue}] of Object.entries(
    budgetItems.audits,
  )) {
    if (score) {
      if (lhr.audits[key].score < score) {
        results.push({
          label: lhr.audits[key].title,
          score: lhr.audits[key].score * 100,
          expected: `> ${score * 100}`,
        });
      }
    }

    if (numericValue) {
      if (lhr.audits[key].numericValue > numericValue) {
        results.push({
          label: lhr.audits[key].title,
          score: lhr.audits[key].numericValue,
          expected: `< ${numericValue}`,
        });
      }
    }
  }

  for (const [key, {score}] of Object.entries(budgetItems.categories)) {
    if (lhr.categories[key].score < score) {
      results.push({
        label: lhr.categories[key].title,
        score: lhr.categories[key].score * 100,
        expected: `> ${score * 100}`,
      });
    }
  }

  return results;
}

function checkIfActionShouldFail(lhr, core) {
  if (
    (core.getInput('lighthouseBudget') && getOverBudgetItems(lhr).length > 0) ||
    (core.getInput('lighthouseScoringBudget') &&
      getScoreBudgetItems(lhr, getCustomLighthouseScoringBudget(core)).length >
        0)
  ) {
    core.setFailed(
      'Lighthouse Audit failed: budget conditions exceeded. See PR comment or attached artifacts for details.',
    );
  }
}

module.exports = {
  getOverBudgetItems: getOverBudgetItems,
  getScoreBudgetItems: getScoreBudgetItems,
  checkIfActionShouldFail: checkIfActionShouldFail,
};
