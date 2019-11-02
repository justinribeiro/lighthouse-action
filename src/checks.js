'use strict';

function getOverBudgetItems(lhr) {
  const budget = lhr.audits['performance-budget'];

  console.log(budget);
  console.log(
    !budget.details ||
      !budget.details.items ||
      !budget.details.items.some(item => item.sizeOverBudget),
  );
  console.log(!budget.details.items.some(item => item.sizeOverBudget));

  if (
    !budget.details ||
    !budget.details.items ||
    !budget.details.items.some(item => item.sizeOverBudget)
  ) {
    return [];
  }
  return budget.details.items;
}

function checkIfActionShouldFail(lhr, core) {
  if (core.getInput('lighthouseBudget') && getOverBudgetItems(lhr).length > 0) {
    core.setFailed(
      'Lighthouse Audit failed: budget conditions exceeded. See PR comment or attached artifacts for details.',
    );
  }
}

module.exports = {
  getOverBudgetItems: getOverBudgetItems,
  checkIfActionShouldFail: checkIfActionShouldFail,
};
