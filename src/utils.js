const {ensureDir} = require('fs-extra');
const {join} = require('path');
const {writeFile} = require('fs').promises;
const fetch = require('node-fetch');
const {
  getFilenamePrefix,
} = require('lighthouse/lighthouse-core/lib/file-namer');

function writeResultsToConsole(lhr, speed) {
  console.log(`Lighthouse Scoring, ${speed}`);
  console.log(`-------------------------`);
  console.log(`Performance: ${lhr.categories.performance.score * 100}`);
  console.log(`Accessibility: ${lhr.categories.accessibility.score * 100}`);
  console.log(
    `Best Practices: ${lhr.categories['best-practices'].score * 100}`,
  );
  console.log(`SEO: ${lhr.categories.seo.score * 100}`);
  console.log(`-------------------------`);
  console.log(`FCP: ${lhr.audits['first-contentful-paint'].displayValue}`);
  console.log(`FMP: ${lhr.audits['first-meaningful-paint'].displayValue}`);
  console.log(`FID: ${lhr.audits['max-potential-fid'].displayValue}`);
  console.log(`TTI: ${lhr.audits['interactive'].displayValue}`);
  console.log(`First CPU Idle: ${lhr.audits['first-cpu-idle'].displayValue}`);
  console.log(`Speed Index: ${lhr.audits['speed-index'].displayValue}`);
  console.log(`-------------------------`);
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
  let rows = '';
  let timings = '';
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
    timings += `| ${lhr.audits[cat].title} | ${lhr.audits[cat].displayValue} | \n`;
  });

  const data = `
[Lighthouse](https://developers.google.com/web/tools/lighthouse/) report for the changes in this PR:

WPT Profile: ${speed}

| Category | Score |
| ------------- | ------------- |
${rows}

| Measure | Timing |
| ------------- | ------------- |
${timings}

_Tested with Lighthouse v${lhr.lighthouseVersion} via [lighthouse-action](https://github.com/justinribeiro/lighthouse-action)_`;

  await fetch(github.context.payload.pull_request.comments_url, {
    method: 'post',
    body: JSON.stringify({
      body: data,
    }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
  });
}

module.exports = {
  writeResultsToConsole: writeResultsToConsole,
  writeResultsToFileSystem: writeResultsToFileSystem,
  postResultsToPullRequest: postResultsToPullRequest,
};
