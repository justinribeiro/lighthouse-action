# Lighthouse with WPT Network Emulation Profiles, Github Action Edition

> Audit deployed web sites with my artisanal blend of WPT Network Emulation Profiles, Puppeteer, Chrome headless, Lighthouse, and Github Actions.

## Features

- Uses [Puppeteer](https://github.com/GoogleChrome/puppeteer) to start up Chrome with [network emulation settings defined by WebPageTest](https://github.com/WPO-Foundation/webpagetest/blob/master/www/settings/connectivity.ini.sample).
- Supports saving of artifacts to the Github Action run.
- Supports custom Lighthouse configuration via JavaScript file.
- Supports Lighthouse budget.json for failing PRs.
- Supports Lighthouse-based data model scores.js for failing PRs based on _any_ audit score or category.
- Posts results of audit run as a comment on your PR.
  ![image](https://user-images.githubusercontent.com/643503/68270529-5729f400-0012-11ea-8fa9-e3eaeb2ee6f5.png)

## General Disclaimer

While I love automated web performance testing, you should always keep in mind that:

1. That this tool is the first line of testing and is at best a guidepost given the emulation layer.
2. Verify your web performance on actual hardware and devices that your users are using (and you can even run lighthouse reports on those devices too).
3. When in doubt, run a trace in DevTools.

Now let's have some fun and automate a web perf workflow!

## Basic Usage

This is best run against `on: [pull_request]`, so you'll get the report comment, but you technically do not have to use it this way.

```yml
name: Audit Web Performance
on: [pull_request]
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v1
      - name: Generate Lighthouse Report
        uses: justinribeiro/lighthouse-action@master
        with:
          secret: ${{ secrets.GITHUB_TOKEN }}
          url: https://${{ github.sha }}-dot-${{ secrets.GAE_PID }}.appspot.com
          wptConnectionSpeed: threegfast
      - name: Saving Lighthouse Audit Artifacts
        uses: actions/upload-artifact@master
        with:
          name: lighthouse-artifacts
          path: './results'
```

If you don't want the PR comment, the secret is optional.

## Advanced Usage

If you don't want to use the WPT profiles or you want to customize your Lighthouse configuration with headers or custom runs, or you just want to use your existing lighthouse budget.json, this is available via the `lighthouseConfiguration` and `lighthouseBudget` options:

```yml
name: Audit Web Performance
on: [pull_request]
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v1
      - name: Generate Lighthouse Report
        uses: justinribeiro/lighthouse-action@master
        with:
        with:
          secret: ${{ secrets.GITHUB_TOKEN }}
          url: https://justinribeiro.com/
          lighthouseBudget: .github/test/budget.json
          lighthouseScoringBudget: .github/test/scores.js
          lighthouseConfiguration: .github/test/custom-config.js
      - name: Saving Lighthouse Audit Artifacts
        uses: actions/upload-artifact@master
        with:
          name: lighthouse-artifacts
          path: './results'
```

For full details on how to define a lighthouse configuration file, see [Lighthouse Configuration](https://github.com/GoogleChrome/lighthouse/blob/master/docs/configuration.md) for more information.

For full details on how to define a lighthouse budget.json file, see [Performance Budgets (Keep Request Counts Low And File Sizes Small)](https://developers.google.com/web/tools/lighthouse/audits/budgets) for more information.

## Using scores.js to increase your audit power

`scores.js` is based on the Lighthouse JSON output data model and maps one-to-one with the existing keys and definitions within lighthouse. This allows an easy to use, vastly configurable file to test any audit score or raw numeric value that you find important. No having to wait for me to add special parameters. :-)

Let's look at an example `scores.js` file:

```
module.exports = {
  audits: {
    'service-worker': {
      score: 1,
    },
    'first-contentful-paint': {
      score: 1,
      numericValue: 100,
    },
    'first-meaningful-paint': {
      score: 1,
      numericValue: 100,
    },
  },
  categories: {
    performance: {
      score: 0.95,
    },
    accessibility: {
      score: 0.95,
    },
  },
};
```

In this case we can test for either one or two specific keys:

1. `score`: decimal ranging from 0 to 1. If you wanted to verify that your performance is above 95, you'd enter 0.95 like above.
2. `numericValue`: decimal starting at zero. Commonly holds the value out of the trace in milliseconds, good for testing if you want those raw performance numbers.

For a full view of available audits and categories, output a JSON file from the lighthouse cli to get started:

```
$ lighthouse --output json --output-path=./sample.json --chrome-flags="--headless" https://YOUR_URL_HERE.com

```

## Inputs

### `url`

**Required** The URL you'd like Lighthouse to audit.

### `secret`

_Optional_ This is the default secret for your repo as generated by Github Actions. Use the `${{ secrets.GITHUB_TOKEN }}` for this to allow commenting on your PRs.

### `wptConnectionSpeed`

_Optional_ Profiles based on [WebPageTest project connectivity samples](https://github.com/WPO-Foundation/webpagetest/blob/master/www/settings/connectivity.ini.sample), defined in [chrome.js](https://github.com/justinribeiro/lighthouse-action/blob/master/src/chrome.js).

Defaults to `threegfast`. Can be any of the following: `twog`, `threegslow`, `threeg`, `threegfast`, `fourg`, `lte`.

### `lighthouseConfiguration`

_Optional_ File path to custom lighthouse configuration JavaScript file. See [Lighthouse Configuration](https://github.com/GoogleChrome/lighthouse/blob/master/docs/configuration.md) for more information.

### `lighthouseBudget`

_Optional_ File path to custom budget.json file; will fail PRs based on budget result. See [Performance Budgets (Keep Request Counts Low And File Sizes Small)](https://developers.google.com/web/tools/lighthouse/audits/budgets) for more information.

### `lighthouseScoringBudget`

_Optional_ File path to custom scores.js file; will fail PRs based on scoring result. See the above section in this README "Using scores.js to increase your audit power" for more information.

## Outputs

### `resultsPath`

Path to the folder with Lighthouse audit results.

## Live example

For a live example of this action in practice, see [my blog-pwa repo workflow](https://github.com/justinribeiro/blog-pwa/blob/master/.github/workflows/main.yml).

## Why I built this

1. I wanted a simpler, cleaner example anyone could jump into, fork, and make their own.
2. None of the other offerings post on a PR the audit result.
3. I wanted to explore harsher network conditioning, which I already do in things like my [lighthouse-jest-example](https://github.com/justinribeiro/lighthouse-jest-example) fairly successfully.

## The future

1. Add fail case configuration
2. Add server warming flags (which I've found skews scores on a lot of deployments)
3. Add multi-url auditing
