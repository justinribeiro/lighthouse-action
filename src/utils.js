'use strict';

const {ensureDir} = require('fs-extra');
const {join} = require('path');
const {writeFile} = require('fs').promises;
const fetch = require('node-fetch');
const {
  getFilenamePrefix,
} = require('lighthouse/lighthouse-core/lib/file-namer');
const {getOverBudgetItems} = require('./checks');

function generateLogString(speed, rows, timings, failures, version) {
  return `
[Lighthouse](https://developers.google.com/web/tools/lighthouse/) report for the changes in this PR:

WPT Profile: ${speed}

| Category | Score |
| ------------- | ------------- |
${rows}

| Measure | Timing |
| ------------- | ------------- |
${timings}

${failures}

_Tested with Lighthouse v${version} via [lighthouse-action](https://github.com/justinribeiro/lighthouse-action)_`;
}

function parseLighthouseResultsToString(lhr, speed) {
  let rows = '';
  let timings = '';
  let failures = '';

  Object.values(lhr.categories).forEach(cat => {
    rows += `| ${cat.title} | ${cat.score * 100} | \n`;
  });

  [
    'first-contentful-paint',
    'first-meaningful-paint',
    'max-potential-fid',
    'interactive',
    'first-cpu-idle',
    'speed-index',
  ].forEach(cat => {
    if (lhr.audits[cat]) {
      timings += `| ${lhr.audits[cat].title} | ${lhr.audits[cat].displayValue} | \n`;
    }
  });

  const budgetFailures = getOverBudgetItems(lhr);
  if (budgetFailures.length > 0) {
    failures = `
Based on your budget.json settings, the following audits have failed:

| Label | Request Count | Size | Count Over Budget | Size Over Budget |
| ------------- | ------------- | ------------- | ------------- | ------------- |
`;

    budgetFailures.forEach(item => {
      let countOverBudget;
      if (!item.countOverBudget) {
        countOverBudget = 'N/A';
      } else {
        countOverBudget = item.countOverBudget;
      }
      failures += `| ${item.label} | ${item.requestCount} | ${item.size} | ${countOverBudget} | ${item.sizeOverBudget} | \n`;
    });
  }

  return generateLogString(
    speed,
    rows,
    timings,
    failures,
    lhr.lighthouseVersion,
  );
}

function writeResultsToConsole(lhr, speed) {
  const string = parseLighthouseResultsToString(lhr, speed);
  console.log(string);
}

async function writeResultsToFileSystem(report, lhr, core) {
  const resultsPath = join(process.cwd(), 'results');
  await ensureDir(resultsPath);
  const reportPath = join(resultsPath, getFilenamePrefix(lhr));
  await writeFile(`${reportPath}.html`, report);
  await writeFile(`${reportPath}.json`, JSON.stringify(lhr, null, '  '));
  core.setOutput('resultsPath', resultsPath);
}

async function postResultsToPullRequest(lhr, speed, github, secret) {
  const string = parseLighthouseResultsToString(lhr, speed);

  if (github.context.payload.pull_request.comments_url && secret) {
    await fetch(github.context.payload.pull_request.comments_url, {
      method: 'post',
      body: JSON.stringify({
        body: string,
      }),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
    });
  }
}

module.exports = {
  writeResultsToConsole: writeResultsToConsole,
  writeResultsToFileSystem: writeResultsToFileSystem,
  postResultsToPullRequest: postResultsToPullRequest,
};
