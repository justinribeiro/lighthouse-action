'use strict';

const {ensureDir} = require('fs-extra');
const {join} = require('path');
const {writeFile} = require('fs').promises;
const fetch = require('node-fetch');
const {getFilenamePrefix} = require('lighthouse/report/generator/file-namer');
const {getOverBudgetItems, getScoreBudgetItems} = require('./checks');
const {getCustomLighthouseScoringBudget} = require('./config');

function generateLogString(
  speed,
  rows,
  timings,
  failures,
  scoreFailures,
  version,
) {
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

${scoreFailures}

_Tested with Lighthouse v${version} via [lighthouse-action](https://github.com/justinribeiro/lighthouse-action)_`;
}

function parseLighthouseResultsToString(core, lhr, speed) {
  let rows = '';
  let timings = '';
  let failures = '';
  let scoreFailures = '';

  Object.values(lhr.categories).forEach(cat => {
    rows += `| ${cat.title} | ${cat.score * 100} | \n`;
  });

  [
    'first-contentful-paint',
    'interactive',
    'first-meaningful-paint',
    'max-potential-fid',
    'total-blocking-time',
    'speed-index',
    'largest-contentful-paint',
    'cumulative-layout-shift',
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

  const scoresBudget = getCustomLighthouseScoringBudget(core);
  let scoreBudgetFailures;
  if (scoresBudget) {
    scoreBudgetFailures = getScoreBudgetItems(lhr, scoresBudget);
  } else {
    scoreBudgetFailures = [];
  }

  if (scoreBudgetFailures.length > 0) {
    scoreFailures = `
Based on your scores.js settings, the following audits have failed:

| Audit / Category | Score / Value | Expected |
| ------------- | ------------- | ------------- |
`;

    scoreBudgetFailures.forEach(item => {
      scoreFailures += `| ${item.label} | ${item.score} | ${item.expected} | \n`;
    });
  }

  return generateLogString(
    speed,
    rows,
    timings,
    failures,
    scoreFailures,
    lhr.lighthouseVersion,
  );
}

function writeResultsToConsole(core, lhr, speed) {
  const string = parseLighthouseResultsToString(core, lhr, speed);
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

async function postResultsToPullRequest(core, lhr, speed, github, secret) {
  const string = parseLighthouseResultsToString(core, lhr, speed);

  if (
    github.context.payload.pull_request &&
    github.context.payload.pull_request.comments_url &&
    secret
  ) {
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
