const {ensureDir} = require('fs-extra');
const {join} = require('path');
const {writeFile} = require('fs').promises;
const {readFileSync} = require('fs');
const {
  getFilenamePrefix,
} = require('lighthouse/lighthouse-core/lib/file-namer');

function writeResultsToConsole(lhr) {
  console.log(`Lighthouse Scoring`);
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
  await writeFile(reportPath + '.html', report);
  await writeFile(reportPath + '.json', JSON.stringify(lhr, null, '  '));
  core.setOutput('resultsPath', resultsPath);
}

module.exports = {
  writeResultsToConsole: writeResultsToConsole,
  writeResultsToFileSystem: writeResultsToFileSystem,
};
