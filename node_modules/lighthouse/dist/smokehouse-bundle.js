(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}(g.Lighthouse || (g.Lighthouse = {})).Smokehouse = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Smoke test runner.
 * Used to test integrations that run Lighthouse within a browser (i.e. LR, DevTools)
 * Supports skipping and modifiying expectations to match the environment.
 */

/* eslint-disable no-console */

const cloneDeep = require('lodash.clonedeep');
const smokeTests = require('../test-definitions/core-tests.js');
const {runSmokehouse} = require('../smokehouse.js');

/**
 * @param {Smokehouse.SmokehouseLibOptions} options
 */
async function smokehouse(options) {
  const {urlFilterRegex, skip, modify, ...smokehouseOptions} = options;

  const clonedTests = cloneDeep(smokeTests);
  const modifiedTests = clonedTests.map(test => {
    const modifiedExpectations = [];
    for (const expected of test.expectations) {
      if (urlFilterRegex && !expected.lhr.requestedUrl.match(urlFilterRegex)) {
        continue;
      }

      const reasonToSkip = skip && skip(test, expected);
      if (reasonToSkip) {
        console.log(`skipping ${expected.lhr.requestedUrl}: ${reasonToSkip}`);
        continue;
      }

      modify && modify(test, expected);
      modifiedExpectations.push(expected);
    }

    return {
      ...test,
      expectations: modifiedExpectations,
    };
  }).filter(test => test.expectations.length > 0);

  return runSmokehouse(modifiedTests, smokehouseOptions);
}

module.exports = smokehouse;

},{"../smokehouse.js":5,"../test-definitions/core-tests.js":10,"lodash.clonedeep":50}],2:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * A class that maintains a concurrency pool to coordinate many jobs that should
 * only be run `concurrencyLimit` at a time.
 * API inspired by http://bluebirdjs.com/docs/api/promise.map.html, but
 * independent callers of `concurrentMap()` share the same concurrency limit.
 */
class ConcurrentMapper {
  constructor() {
    /** @type {Set<Promise<unknown>>} */
    this._promisePool = new Set();

    /**
     * The limits of all currently running jobs. There will be duplicates.
     * @type {Array<number>}
     */
    this._allConcurrencyLimits = [];
  }

  /**
   * Runs callbackfn on `values` in parallel, at a max of `concurrency` at a
   * time. Resolves to an array of the results or rejects with the first
   * rejected result. Default `concurrency` limit is `Infinity`.
   * @template T, U
   * @param {Array<T>} values
   * @param {(value: T, index: number, array: Array<T>) => Promise<U>} callbackfn
   * @param {{concurrency: number}} [options]
   * @return {Promise<Array<U>>}
   */
  static async map(values, callbackfn, options) {
    const cm = new ConcurrentMapper();
    return cm.pooledMap(values, callbackfn, options);
  }

  /**
   * Returns whether there are fewer running jobs than the minimum current
   * concurrency limit and the proposed new `concurrencyLimit`.
   * @param {number} concurrencyLimit
   */
  _canRunMoreAtLimit(concurrencyLimit) {
    return this._promisePool.size < concurrencyLimit &&
        this._promisePool.size < Math.min(...this._allConcurrencyLimits);
  }

  /**
   * Add a job to pool.
   * @param {Promise<unknown>} job
   * @param {number} concurrencyLimit
   */
  _addJob(job, concurrencyLimit) {
    this._promisePool.add(job);
    this._allConcurrencyLimits.push(concurrencyLimit);
  }

  /**
   * Remove a job from pool.
   * @param {Promise<unknown>} job
   * @param {number} concurrencyLimit
   */
  _removeJob(job, concurrencyLimit) {
    this._promisePool.delete(job);

    const limitIndex = this._allConcurrencyLimits.indexOf(concurrencyLimit);
    if (limitIndex === -1) {
      throw new Error('No current limit found for finishing job');
    }
    this._allConcurrencyLimits.splice(limitIndex, 1);
  }

  /**
   * Runs callbackfn on `values` in parallel, at a max of `concurrency` at
   * a time across all callers on this instance. Resolves to an array of the
   * results (for each caller separately) or rejects with the first rejected
   * result. Default `concurrency` limit is `Infinity`.
   * @template T, U
   * @param {Array<T>} values
   * @param {(value: T, index: number, array: Array<T>) => Promise<U>} callbackfn
   * @param {{concurrency: number}} [options]
   * @return {Promise<Array<U>>}
   */
  async pooledMap(values, callbackfn, options = {concurrency: Infinity}) {
    const {concurrency} = options;
    const result = [];

    for (let i = 0; i < values.length; i++) {
      // Wait until concurrency allows another run.
      while (!this._canRunMoreAtLimit(concurrency)) {
        // Unconditionally catch since we only care about our own failures
        // (caught in the Promise.all below), not other callers.
        await Promise.race(this._promisePool).catch(() => {});
      }

      // innerPromise removes itself from the pool and resolves on return from callback.
      const innerPromise = callbackfn(values[i], i, values)
        .finally(() => this._removeJob(innerPromise, concurrency));

      this._addJob(innerPromise, concurrency);
      result.push(innerPromise);
    }

    return Promise.all(result);
  }
}

module.exports = ConcurrentMapper;

},{}],3:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * A simple buffered log to use in place of `console`.
 */
class LocalConsole {
  constructor() {
    this._log = '';
  }

  /**
   * @param {string} str
   */
  log(str) {
    this._log += str + '\n';
  }

  /**
   * Log but without the ending newline.
   * @param {string} str
   */
  write(str) {
    this._log += str;
  }

  /**
   * @return {string}
   */
  getLog() {
    return this._log;
  }

  /**
   * Append a stdout and stderr to this log.
   * @param {{stdout: string, stderr: string}} stdStrings
   */
  adoptStdStrings(stdStrings) {
    this.write(stdStrings.stdout);
    // stderr accrues many empty lines. Don't log unless there's content.
    if (/\S/.test(stdStrings.stderr)) {
      this.write(stdStrings.stderr);
    }
  }
}

module.exports = LocalConsole;

},{}],4:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview An assertion library for comparing smoke-test expectations
 * against the results actually collected from Lighthouse.
 */

const cloneDeep = require('lodash.clonedeep');
const log = require('lighthouse-logger');
const LocalConsole = require('./lib/local-console.js');

const NUMBER_REGEXP = /(?:\d|\.)+/.source;
const OPS_REGEXP = /<=?|>=?|\+\/-|±/.source;
// An optional number, optional whitespace, an operator, optional whitespace, a number.
const NUMERICAL_EXPECTATION_REGEXP =
  new RegExp(`^(${NUMBER_REGEXP})?\\s*(${OPS_REGEXP})\\s*(${NUMBER_REGEXP})$`);

/**
 * @typedef Difference
 * @property {string} path
 * @property {any} actual
 * @property {any} expected
 */

/**
 * @typedef Comparison
 * @property {string} name
 * @property {any} actual
 * @property {any} expected
 * @property {boolean} equal
 * @property {Difference|null} [diff]
 */

/**
 * Checks if the actual value matches the expectation. Does not recursively search. This supports
 *    - Greater than/less than operators, e.g. "<100", ">90"
 *    - Regular expressions
 *    - Strict equality
 *    - plus or minus a margin of error, e.g. '10+/-5', '100±10'
 *
 * @param {*} actual
 * @param {*} expected
 * @return {boolean}
 */
function matchesExpectation(actual, expected) {
  if (typeof actual === 'number' && NUMERICAL_EXPECTATION_REGEXP.test(expected)) {
    const parts = expected.match(NUMERICAL_EXPECTATION_REGEXP);
    const [, prefixNumber, operator, postfixNumber] = parts;
    switch (operator) {
      case '>':
        return actual > postfixNumber;
      case '>=':
        return actual >= postfixNumber;
      case '<':
        return actual < postfixNumber;
      case '<=':
        return actual <= postfixNumber;
      case '+/-':
      case '±':
        return Math.abs(actual - prefixNumber) <= postfixNumber;
      default:
        throw new Error(`unexpected operator ${operator}`);
    }
  } else if (typeof actual === 'string' && expected instanceof RegExp && expected.test(actual)) {
    return true;
  } else {
    // Strict equality check, plus NaN equivalence.
    return Object.is(actual, expected);
  }
}

/**
 * Walk down expected result, comparing to actual result. If a difference is found,
 * the path to the difference is returned, along with the expected primitive value
 * and the value actually found at that location. If no difference is found, returns
 * null.
 *
 * Only checks own enumerable properties, not object prototypes, and will loop
 * until the stack is exhausted, so works best with simple objects (e.g. parsed JSON).
 * @param {string} path
 * @param {*} actual
 * @param {*} expected
 * @return {(Difference|null)}
 */
function findDifference(path, actual, expected) {
  if (matchesExpectation(actual, expected)) {
    return null;
  }

  // If they aren't both an object we can't recurse further, so this is the difference.
  if (actual === null || expected === null || typeof actual !== 'object' ||
      typeof expected !== 'object' || expected instanceof RegExp) {
    return {
      path,
      actual,
      expected,
    };
  }

  // We only care that all expected's own properties are on actual (and not the other way around).
  // Note an expected `undefined` can match an actual that is either `undefined` or not defined.
  for (const key of Object.keys(expected)) {
    // Bracket numbers, but property names requiring quotes will still be unquoted.
    const keyAccessor = /^\d+$/.test(key) ? `[${key}]` : `.${key}`;
    const keyPath = path + keyAccessor;
    const expectedValue = expected[key];

    const actualValue = actual[key];
    const subDifference = findDifference(keyPath, actualValue, expectedValue);

    // Break on first difference found.
    if (subDifference) {
      return subDifference;
    }
  }

  // If the expected value is an array, assert the length as well.
  // This still allows for asserting that the first n elements of an array are specified elements,
  // but requires using an object literal (ex: {0: x, 1: y, 2: z} matches [x, y, z, q, w, e] and
  // {0: x, 1: y, 2: z, length: 5} does not match [x, y, z].
  if (Array.isArray(expected) && actual.length !== expected.length) {
    return {
      path: `${path}.length`,
      actual,
      expected,
    };
  }

  return null;
}

/**
 * @param {string} name – name of the value being asserted on (e.g. the result of a certain audit)
 * @param {any} actualResult
 * @param {any} expectedResult
 * @return {Comparison}
 */
function makeComparison(name, actualResult, expectedResult) {
  const diff = findDifference(name, actualResult, expectedResult);

  return {
    name,
    actual: actualResult,
    expected: expectedResult,
    equal: !diff,
    diff,
  };
}

/**
 * Delete expectations that don't match environment criteria.
 * @param {LocalConsole} localConsole
 * @param {LH.Result} lhr
 * @param {Smokehouse.ExpectedRunnerResult} expected
 */
function pruneExpectations(localConsole, lhr, expected) {
  const userAgent = lhr.environment.hostUserAgent;
  const userAgentMatch = /Chrome\/(\d+)/.exec(userAgent); // Chrome/85.0.4174.0
  if (!userAgentMatch) throw new Error('Could not get chrome version.');
  const actualChromeVersion = Number(userAgentMatch[1]);
  /**
   * @param {*} obj
   */
  function failsChromeVersionCheck(obj) {
    if (obj._minChromiumMilestone && actualChromeVersion < obj._minChromiumMilestone) return true;
    if (obj._maxChromiumMilestone && actualChromeVersion > obj._maxChromiumMilestone) return true;
    return false;
  }

  /**
   * @param {*} obj
   */
  function pruneNewerChromeExpectations(obj) {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (!value || typeof value !== 'object') {
        continue;
      }

      if (failsChromeVersionCheck(value)) {
        localConsole.log([
          `[${key}] failed chrome version check, pruning expectation:`,
          JSON.stringify(value, null, 2),
          `Actual Chromium version: ${actualChromeVersion}`,
        ].join(' '));
        delete obj[key];
      } else {
        pruneNewerChromeExpectations(value);
      }
    }
    delete obj._minChromiumMilestone;
    delete obj._maxChromiumMilestone;
  }

  const cloned = cloneDeep(expected);

  pruneNewerChromeExpectations(cloned);
  return cloned;
}

/**
 * Collate results into comparisons of actual and expected scores on each audit/artifact.
 * @param {LocalConsole} localConsole
 * @param {{lhr: LH.Result, artifacts: LH.Artifacts, networkRequests?: string[]}} actual
 * @param {Smokehouse.ExpectedRunnerResult} expected
 * @return {Comparison[]}
 */
function collateResults(localConsole, actual, expected) {
  // If actual run had a runtimeError, expected *must* have a runtimeError.
  // Relies on the fact that an `undefined` argument to makeComparison() can only match `undefined`.
  const runtimeErrorAssertion = makeComparison('runtimeError', actual.lhr.runtimeError,
      expected.lhr.runtimeError);

  // Same for warnings, exclude the slow CPU warning which is flaky and differs between CI machines.
  const warnings = actual.lhr.runWarnings
    .filter(warning => !warning.includes('loaded too slowly'))
    .filter(warning => !warning.includes('a slower CPU'));
  const runWarningsAssertion = makeComparison('runWarnings', warnings,
      expected.lhr.runWarnings || []);

  /** @type {Comparison[]} */
  let artifactAssertions = [];
  if (expected.artifacts) {
    const expectedArtifacts = expected.artifacts;
    const artifactNames = /** @type {(keyof LH.Artifacts)[]} */ (Object.keys(expectedArtifacts));
    const actualArtifacts = actual.artifacts || {};
    artifactAssertions = artifactNames.map(artifactName => {
      if (!(artifactName in actualArtifacts)) {
        localConsole.log(log.redify('Error: ') +
          `Config run did not generate artifact ${artifactName}`);
      }

      const actualResult = actualArtifacts[artifactName];
      const expectedResult = expectedArtifacts[artifactName];
      return makeComparison(artifactName + ' artifact', actualResult, expectedResult);
    });
  }

  /** @type {Comparison[]} */
  let auditAssertions = [];
  auditAssertions = Object.keys(expected.lhr.audits).map(auditName => {
    const actualResult = actual.lhr.audits[auditName];
    if (!actualResult) {
      localConsole.log(log.redify('Error: ') +
        `Config did not trigger run of expected audit ${auditName}`);
    }

    const expectedResult = expected.lhr.audits[auditName];
    return makeComparison(auditName + ' audit', actualResult, expectedResult);
  });

  /** @type {Comparison[]} */
  const requestCountAssertion = [];
  if (expected.networkRequests) {
    requestCountAssertion.push(makeComparison(
      'Requests',
      actual.networkRequests,
      expected.networkRequests
    ));
  }

  return [
    {
      name: 'final url',
      actual: actual.lhr.finalUrl,
      expected: expected.lhr.finalUrl,
      equal: actual.lhr.finalUrl === expected.lhr.finalUrl,
    },
    runtimeErrorAssertion,
    runWarningsAssertion,
    ...requestCountAssertion,
    ...artifactAssertions,
    ...auditAssertions,
  ];
}

/**
 * @param {unknown} obj
 */
function isPlainObject(obj) {
  return Object.prototype.toString.call(obj) === '[object Object]';
}

/**
 * Log the result of an assertion of actual and expected results to the provided
 * console.
 * @param {LocalConsole} localConsole
 * @param {Comparison} assertion
 */
function reportAssertion(localConsole, assertion) {
  // @ts-expect-error - this doesn't exist now but could one day, so try not to break the future
  const _toJSON = RegExp.prototype.toJSON;
  // @ts-expect-error
  // eslint-disable-next-line no-extend-native
  RegExp.prototype.toJSON = RegExp.prototype.toString;

  if (assertion.equal) {
    if (isPlainObject(assertion.actual)) {
      localConsole.log(`  ${log.greenify(log.tick)} ${assertion.name}`);
    } else {
      localConsole.log(`  ${log.greenify(log.tick)} ${assertion.name}: ` +
          log.greenify(assertion.actual));
    }
  } else {
    if (assertion.diff) {
      const diff = assertion.diff;
      const fullActual = String(JSON.stringify(assertion.actual, null, 2))
          .replace(/\n/g, '\n      ');
      const msg = `
  ${log.redify(log.cross)} difference at ${log.bold}${diff.path}${log.reset}
              expected: ${JSON.stringify(diff.expected)}
                 found: ${JSON.stringify(diff.actual)}

          found result:
      ${log.redify(fullActual)}
`;
      localConsole.log(msg);
    } else {
      localConsole.log(`  ${log.redify(log.cross)} ${assertion.name}:
              expected: ${JSON.stringify(assertion.expected)}
                 found: ${JSON.stringify(assertion.actual)}
`);
    }
  }

  // @ts-expect-error
  // eslint-disable-next-line no-extend-native
  RegExp.prototype.toJSON = _toJSON;
}

/**
 * @param {number} count
 * @return {string}
 */
function assertLogString(count) {
  const plural = count === 1 ? '' : 's';
  return `${count} assertion${plural}`;
}

/**
 * Log all the comparisons between actual and expected test results, then print
 * summary. Returns count of passed and failed tests.
 * @param {{lhr: LH.Result, artifacts: LH.Artifacts, networkRequests?: string[]}} actual
 * @param {Smokehouse.ExpectedRunnerResult} expected
 * @param {{isDebug?: boolean}=} reportOptions
 * @return {{passed: number, failed: number, log: string}}
 */
function report(actual, expected, reportOptions = {}) {
  const localConsole = new LocalConsole();

  expected = pruneExpectations(localConsole, actual.lhr, expected);
  const comparisons = collateResults(localConsole, actual, expected);

  let correctCount = 0;
  let failedCount = 0;

  comparisons.forEach(assertion => {
    if (assertion.equal) {
      correctCount++;
    } else {
      failedCount++;
    }

    if (!assertion.equal || reportOptions.isDebug) {
      reportAssertion(localConsole, assertion);
    }
  });

  const correctStr = assertLogString(correctCount);
  const colorFn = correctCount === 0 ? log.redify : log.greenify;
  localConsole.log(`  Correctly passed ${colorFn(correctStr)}`);

  if (failedCount) {
    const failedString = assertLogString(failedCount);
    const failedColorFn = failedCount === 0 ? log.greenify : log.redify;
    localConsole.log(`  Failed ${failedColorFn(failedString)}`);
  }
  localConsole.write('\n');

  return {
    passed: correctCount,
    failed: failedCount,
    log: localConsole.getLog(),
  };
}

module.exports = report;

},{"./lib/local-console.js":3,"lighthouse-logger":46,"lodash.clonedeep":50}],5:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview An end-to-end test runner for Lighthouse. Takes a set of smoke
 * test definitions and a method of running Lighthouse, returns whether all the
 * smoke tests passed.
 */

const log = require('lighthouse-logger');
const cliLighthouseRunner = require('./lighthouse-runners/cli.js').runLighthouse;
const getAssertionReport = require('./report-assert.js');
const LocalConsole = require('./lib/local-console.js');
const ConcurrentMapper = require('./lib/concurrent-mapper.js');

/* eslint-disable no-console */

/** @typedef {import('./lib/child-process-error.js')} ChildProcessError */

// The number of concurrent (`!runSerially`) tests to run if `jobs` isn't set.
const DEFAULT_CONCURRENT_RUNS = 5;
const DEFAULT_RETRIES = 0;

/**
 * @typedef SmokehouseResult
 * @property {string} id
 * @property {boolean} success
 * @property {Array<{passed: number, failed: number, log: string}>} expectationResults
 */

/**
 * Runs the selected smoke tests. Returns whether all assertions pass.
 * @param {Array<Smokehouse.TestDfn>} smokeTestDefns
 * @param {Smokehouse.SmokehouseOptions} smokehouseOptions
 * @return {Promise<{success: boolean, testResults: SmokehouseResult[]}>}
 */
async function runSmokehouse(smokeTestDefns, smokehouseOptions) {
  const {
    isDebug,
    jobs = DEFAULT_CONCURRENT_RUNS,
    retries = DEFAULT_RETRIES,
    lighthouseRunner = cliLighthouseRunner,
    takeNetworkRequestUrls,
  } = smokehouseOptions;
  assertPositiveInteger('jobs', jobs);
  assertNonNegativeInteger('retries', retries);

  // Run each testDefn's tests in parallel based on the concurrencyLimit.
  const concurrentMapper = new ConcurrentMapper();
  const smokePromises = [];
  for (const testDefn of smokeTestDefns) {
    // If defn is set to `runSerially`, we'll run its tests in succession, not parallel.
    const concurrency = testDefn.runSerially ? 1 : jobs;
    const options = {concurrency, lighthouseRunner, retries, isDebug, takeNetworkRequestUrls};
    const result = runSmokeTestDefn(concurrentMapper, testDefn, options);
    smokePromises.push(result);
  }
  const testResults = await Promise.all(smokePromises);

  let passingCount = 0;
  let failingCount = 0;
  for (const testResult of testResults) {
    for (const expectationResult of testResult.expectationResults) {
      passingCount += expectationResult.passed;
      failingCount += expectationResult.failed;
    }
  }
  if (passingCount) {
    console.log(log.greenify(`${passingCount} expectations passing`));
  }
  if (failingCount) {
    console.log(log.redify(`${failingCount} expectations failing`));
  }

  // Print and fail if there were failing tests.
  const failingDefns = testResults.filter(result => !result.success);
  if (failingDefns.length) {
    const testNames = failingDefns.map(d => d.id).join(', ');
    console.error(log.redify(`We have ${failingDefns.length} failing smoketests: ${testNames}`));
    return {success: false, testResults};
  }

  return {success: true, testResults};
}

/**
 * @param {string} loggableName
 * @param {number} value
 */
function assertPositiveInteger(loggableName, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${loggableName} must be a positive integer`);
  }
}
/**
 * @param {string} loggableName
 * @param {number} value
 */
function assertNonNegativeInteger(loggableName, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${loggableName} must be a non-negative integer`);
  }
}

/**
 * Run all the smoke tests specified, displaying output from each, in order,
 * once all are finished.
 * @param {ConcurrentMapper} concurrentMapper
 * @param {Smokehouse.TestDfn} smokeTestDefn
 * @param {{concurrency: number, retries: number, lighthouseRunner: Smokehouse.LighthouseRunner, isDebug?: boolean, takeNetworkRequestUrls?: () => string[]}} defnOptions
 * @return {Promise<SmokehouseResult>}
 */
async function runSmokeTestDefn(concurrentMapper, smokeTestDefn, defnOptions) {
  const {id, config: configJson, expectations} = smokeTestDefn;
  const {concurrency, lighthouseRunner, retries, isDebug, takeNetworkRequestUrls} = defnOptions;

  const individualTests = expectations.map(expectation => {
    return {
      requestedUrl: expectation.lhr.requestedUrl,
      configJson,
      expectation,
      lighthouseRunner,
      retries,
      isDebug,
      takeNetworkRequestUrls,
    };
  });

  // Loop sequentially over expectations, comparing against Lighthouse run, and
  // reporting result.
  const results = await concurrentMapper.pooledMap(individualTests, (test, index) => {
    if (index === 0) console.log(`${purpleify(id)} smoketest starting…`);
    return runSmokeTest(test);
  }, {concurrency});

  console.log(`\n${purpleify(id)} smoketest results:`);

  let passingTestCount = 0;
  let failingTestCount = 0;
  for (const result of results) {
    if (result.failed) {
      failingTestCount++;
    } else {
      passingTestCount++;
    }

    console.log(result.log);
  }

  console.log(`${purpleify(id)} smoketest complete.`);
  if (passingTestCount) {
    console.log(log.greenify(`  ${passingTestCount} test(s) passing`));
  }
  if (failingTestCount) {
    console.log(log.redify(`  ${failingTestCount} test(s) failing`));
  }
  console.log(''); // extra line break

  return {
    id,
    success: failingTestCount === 0,
    expectationResults: results,
  };
}

/** @param {string} str */
function purpleify(str) {
  return `${log.purple}${str}${log.reset}`;
}

/**
 * Run Lighthouse in the selected runner. Returns `log`` for logging once
 * all tests in a defn are complete.
 * @param {{requestedUrl: string, configJson?: LH.Config.Json, expectation: Smokehouse.ExpectedRunnerResult, lighthouseRunner: Smokehouse.LighthouseRunner, retries: number, isDebug?: boolean, takeNetworkRequestUrls?: () => string[]}} testOptions
 * @return {Promise<{passed: number, failed: number, log: string}>}
 */
async function runSmokeTest(testOptions) {
  // Use a buffered LocalConsole to keep logged output so it's not interleaved
  // with other currently running tests.
  const localConsole = new LocalConsole();
  const {
    requestedUrl,
    configJson,
    expectation,
    lighthouseRunner,
    retries,
    isDebug,
    takeNetworkRequestUrls,
  } = testOptions;

  // Rerun test until there's a passing result or retries are exhausted to prevent flakes.
  let result;
  let report;
  for (let i = 0; i <= retries; i++) {
    if (i === 0) {
      localConsole.log(`Doing a run of '${requestedUrl}'...`);
    } else {
      localConsole.log(`Retrying run (${i} out of ${retries} retries)...`);
    }

    // Run Lighthouse.
    try {
      result = {
        ...await lighthouseRunner(requestedUrl, configJson, {isDebug}),
        networkRequests: takeNetworkRequestUrls ? takeNetworkRequestUrls() : undefined,
      };
    } catch (e) {
      // Clear the network requests so that when we retry, we don't see duplicates.
      if (takeNetworkRequestUrls) takeNetworkRequestUrls();

      logChildProcessError(localConsole, e);
      continue; // Retry, if possible.
    }

    // Assert result.
    report = getAssertionReport(result, expectation, {isDebug});
    if (report.failed) {
      localConsole.log(`${report.failed} assertion(s) failed.`);
      continue; // Retry, if possible.
    }

    break; // Passing result, no need to retry.
  }

  // Write result log if we have one.
  if (result) {
    localConsole.write(result.log);
  }

  // Without an assertion report, not much detail to share but a failure.
  if (!report) {
    return {
      passed: 0,
      failed: 1,
      log: localConsole.getLog(),
    };
  }

  localConsole.write(report.log);
  return {
    passed: report.passed,
    failed: report.failed,
    log: localConsole.getLog(),
  };
}

/**
 * Logs an error to the console, including stdout and stderr if `err` is a
 * `ChildProcessError`.
 * @param {LocalConsole} localConsole
 * @param {ChildProcessError|Error} err
 */
function logChildProcessError(localConsole, err) {
  if ('stdout' in err && 'stderr' in err) {
    localConsole.adoptStdStrings(err);
  }

  localConsole.log(log.redify('Error: ') + err.message);
}

module.exports = {
  runSmokehouse,
};

},{"./lib/concurrent-mapper.js":2,"./lib/local-console.js":3,"./lighthouse-runners/cli.js":44,"./report-assert.js":4,"lighthouse-logger":46}],6:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits for axe.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: [
      'accessibility',
    ],
  },
};

},{}],7:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-disable max-len */

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for byte efficiency tests
 */
const expectations = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/a11y/a11y_tester.html',
      finalUrl: 'http://localhost:10200/a11y/a11y_tester.html',
      audits: {
        'aria-allowed-attr': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-allowed-attr',
                  'snippet': '<div id="aria-allowed-attr" role="alert" aria-checked="true">',
                  'explanation': 'Fix any of the following:\n  ARIA attribute is not allowed: aria-checked="true"',
                  'nodeLabel': 'body > section > div#aria-allowed-attr',
                },
              },
            ],
          },
        },
        'aria-hidden-body': {
          score: 1,
          details: {
            'type': 'table',
            'headings': [],
            'items': [],
          },
        },
        'aria-hidden-focus': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': '>0',
                  },
                  'selector': 'body > section > div#aria-hidden-focus',
                  'snippet': '<div id="aria-hidden-focus" aria-hidden="true">',
                  'explanation': 'Fix all of the following:\n  Focusable content should be disabled or be removed from the DOM',
                  'nodeLabel': 'Focusable Button',
                },
              },
            ],
          },
        },
        'aria-input-field-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': '>0',
                  },
                  'selector': 'body > section > div#aria-input-field-name',
                  'snippet': '<div id="aria-input-field-name" role="textbox">',
                  'explanation': 'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'text-in-a-box',
                },
              },
            ],
          },
        },
        'aria-meter-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': '>0',
                  },
                  'selector': 'body > section > div#aria-meter-name',
                  'snippet': '<div id="aria-meter-name" role="meter">',
                  'explanation': 'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'text-in-a-box',
                },
              },
            ],
          },
        },
        'aria-progressbar-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': '>0',
                  },
                  'selector': 'body > section > div#aria-progressbar-name',
                  'snippet': '<div id="aria-progressbar-name" role="progressbar">',
                  'explanation': 'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'text-in-a-box',
                },
              },
            ],
          },
        },
        'aria-treeitem-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': 0,
                  },
                  'selector': 'body > section > div > div#aria-treeitem-name',
                  'snippet': '<div id="aria-treeitem-name" role="treeitem">',
                  'explanation': 'Fix any of the following:\n  Element does not have text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > div > div#aria-treeitem-name',
                },
              },
            ],
          },
        },
        'aria-command-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': 0,
                  },
                  'selector': 'body > section > div#aria-command-name',
                  'snippet': '<div id="aria-command-name" role="button">',
                  'explanation': 'Fix any of the following:\n  Element does not have text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > div#aria-command-name',
                },
              },
            ],
          },
        },
        'aria-tooltip-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'boundingRect': {
                    'width': '>0',
                    'height': 0,
                  },
                  'selector': 'body > section > div#aria-tooltip-name',
                  'snippet': '<div id="aria-tooltip-name" role="tooltip">',
                  'explanation': 'Fix any of the following:\n  Element does not have text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > div#aria-tooltip-name',
                },
              },
            ],
          },
        },
        'aria-required-children': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-required-children',
                  'snippet': '<div id="aria-required-children" role="radiogroup">',
                  'explanation': 'Fix any of the following:\n  Required ARIA child role not present: radio',
                  'nodeLabel': 'body > section > div#aria-required-children',
                },
              },
            ],
          },
        },
        'aria-required-parent': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div > div#aria-required-parent',
                  'snippet': '<div id="aria-required-parent" role="option">',
                  'explanation': 'Fix any of the following:\n  Required ARIA parent role not present: listbox',
                  'nodeLabel': 'body > section > div > div#aria-required-parent',
                },
              },
            ],
          },
        },
        'aria-roles': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div',
                  'snippet': '<div role="foo">',
                  'explanation': 'Fix all of the following:\n  Role must be one of the valid ARIA roles: foo',
                  'nodeLabel': 'body > section > div',
                },
              },
            ],
          },
        },
        'aria-toggle-field-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-required-attr',
                  'path': '2,HTML,1,BODY,19,SECTION,0,DIV',
                  'snippet': '<div id="aria-required-attr" role="checkbox">',
                  'explanation': 'Fix any of the following:\n  Element does not have text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > div#aria-required-attr',
                },
              },
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div > div#aria-required-parent',
                  'path': '2,HTML,1,BODY,23,SECTION,0,DIV,0,DIV',
                  'snippet': '<div id="aria-required-parent" role="option">',
                  'nodeLabel': 'body > section > div > div#aria-required-parent',
                },
              },
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-valid-attr',
                  'path': '2,HTML,1,BODY,27,SECTION,0,DIV',
                  'snippet': '<div id="aria-valid-attr" role="checkbox" aria-chked="true">',
                  'nodeLabel': 'body > section > div#aria-valid-attr',
                },
              },
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-valid-attr-value',
                  'path': '2,HTML,1,BODY,29,SECTION,0,DIV',
                  'snippet': '<div id="aria-valid-attr-value" role="checkbox" aria-checked="0">',
                  'nodeLabel': 'body > section > div#aria-valid-attr-value',
                },
              },
            ],
          },
        },
        'aria-valid-attr-value': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-valid-attr-value',
                  'snippet': '<div id="aria-valid-attr-value" role="checkbox" aria-checked="0">',
                  'explanation': 'Fix all of the following:\n  Invalid ARIA attribute value: aria-checked="0"',
                  'nodeLabel': 'body > section > div#aria-valid-attr-value',
                },
              },
            ],
          },
        },
        'aria-valid-attr': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#aria-valid-attr',
                  'snippet': '<div id="aria-valid-attr" role="checkbox" aria-chked="true">',
                  'explanation': 'Fix any of the following:\n  Invalid ARIA attribute name: aria-chked',
                  'nodeLabel': 'body > section > div#aria-valid-attr',
                },
              },
            ],
          },
        },
        'button-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > button#button-name',
                  'snippet': '<button id="button-name">',
                  'explanation': 'Fix any of the following:\n  Element does not have inner text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute\n  Element\'s default semantics were not overridden with role="none" or role="presentation"',
                  'nodeLabel': 'body > section > button#button-name',
                },
              },
            ],
          },
        },
        'bypass': {
          score: 1,
          details: {
            type: 'table',
            headings: [],
            items: [],
          },
        },
        'color-contrast': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#color-contrast',
                  'snippet': '<div id="color-contrast" style="background-color: red; color: pink;">',
                  // Default font size is different depending on the platform (e.g. 28.5 on travis, 30.0 on Mac), and the px-converted units may have variable precision, so use \d+.\d+.
                  'explanation': /^Fix any of the following:\n {2}Element has insufficient color contrast of 2\.59 \(foreground color: #ffc0cb, background color: #ff0000, font size: \d+.\d+pt \(\d+.\d+px\), font weight: normal\). Expected contrast ratio of 3:1$/,
                  'nodeLabel': 'Hello',
                },
              },
            ],
          },
        },
        'definition-list': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > dl#definition-list',
                  'snippet': '<dl id="definition-list">',
                  'explanation': 'Fix all of the following:\n  List element has direct children that are not allowed inside <dt> or <dd> elements',
                  'nodeLabel': 'body > section > dl#definition-list',
                },
              },
            ],
          },
        },
        'dlitem': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#dlitem > dd',
                  'snippet': '<dd>',
                  'explanation': 'Fix any of the following:\n  Description list item does not have a <dl> parent element',
                  'nodeLabel': 'body > section > div#dlitem > dd',
                },
              },
            ],
          },
        },
        'document-title': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'html',
                  'snippet': '<html>',
                  'explanation': 'Fix any of the following:\n  Document does not have a non-empty <title> element',
                  'nodeLabel': 'html',
                },
              },
            ],

          },
        },
        'duplicate-id-active': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > textarea#duplicate-id-active',
                  'path': '2,HTML,1,BODY,39,SECTION,0,TEXTAREA',
                  'snippet': '<textarea id="duplicate-id-active" aria-label="text1">',
                  'explanation': 'Fix any of the following:\n  Document has active elements with the same id attribute: duplicate-id-active',
                  'nodeLabel': 'text1',
                },
              },
            ],
          },
        },
        'duplicate-id-aria': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#duplicate-id-aria',
                  'path': '2,HTML,1,BODY,41,SECTION,0,DIV',
                  'snippet': '<div id="duplicate-id-aria" class="duplicate-id-aria">',
                  'explanation': 'Fix any of the following:\n  Document has multiple elements referenced with ARIA with the same id attribute: duplicate-id-aria',
                  'nodeLabel': 'body > section > div#duplicate-id-aria',
                },
              },
            ],
          },
        },
        'form-field-multiple-labels': {
          score: null,
          scoreDisplayMode: 'informative',
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > input#form-field-multiple-labels',
                  'path': '2,HTML,1,BODY,43,SECTION,2,INPUT',
                  'snippet': '<input type="checkbox" id="form-field-multiple-labels">',
                  'explanation': 'Fix all of the following:\n  Multiple label elements is not widely supported in assistive technologies. Ensure the first label contains all necessary information.',
                  'nodeLabel': 'body > section > input#form-field-multiple-labels',
                },
              },
            ],
          },
        },
        'frame-title': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > iframe#frame-title',
                  'snippet': '<iframe id="frame-title">',
                  'explanation': 'Fix any of the following:\n  Element has no title attribute\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element\'s default semantics were not overridden with role="none" or role="presentation"',
                  'nodeLabel': 'body > section > iframe#frame-title',
                },
              },
            ],
          },
        },
        'heading-order': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > h3',
                  'path': '2,HTML,1,BODY,47,SECTION,1,H3',
                  'snippet': '<h3>',
                  'explanation': 'Fix any of the following:\n  Heading order invalid',
                  'nodeLabel': 'sub-sub-header',
                },
              },
            ],
          },
        },
        'html-has-lang': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'html',
                  'snippet': '<html>',
                  'explanation': 'Fix any of the following:\n  The <html> element does not have a lang attribute',
                  'nodeLabel': 'html',
                },
              },
            ],
          },
        },
        'image-alt': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > img#image-alt',
                  'snippet': '<img id="image-alt" src="./bogus.jpg">',
                  'explanation': 'Fix any of the following:\n  Element does not have an alt attribute\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute\n  Element\'s default semantics were not overridden with role="none" or role="presentation"',
                  'nodeLabel': 'body > section > img#image-alt',
                },
              },
            ],
          },
        },
        'input-image-alt': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > input#input-image-alt',
                  'snippet': '<input type="image" id="input-image-alt">',
                  'explanation': 'Fix any of the following:\n  Element has no alt attribute\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > input#input-image-alt',
                },
              },
            ],
          },
        },
        // TODO(paulirish): restore when we stop using --enable-features=AutofillShowTypePredictions
        // See https://github.com/GoogleChrome/lighthouse/pull/11342
        // 'label': {
        //   score: 0,
        //   details: {
        //     items: [
        //       {
        //         node: {
        //           'type': 'node',
        //           'selector': '#label',
        //           'snippet': '<input id="label" type="text">',
        //           'explanation': 'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Form element does not have an implicit (wrapped) <label>\n  Form element does not have an explicit <label>\n  Element has no title attribute or the title attribute is empty',
        //           'nodeLabel': 'input',
        //         },
        //       },
        //     ],
        //   },
        // },
        'link-name': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > a#link-name',
                  'snippet': '<a id="link-name" href="google.com">',
                  'explanation': 'Fix all of the following:\n  Element is in tab order and does not have accessible text\n\nFix any of the following:\n  Element does not have text that is visible to screen readers\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute',
                  'nodeLabel': 'body > section > a#link-name',
                },
              },
            ],
          },
        },
        'list': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > ul#list',
                  'snippet': '<ul id="list">',
                  'explanation': 'Fix all of the following:\n  List element has direct children that are not allowed inside <li> elements',
                  'nodeLabel': 'body > section > ul#list',
                },
              },
            ],
          },
        },
        'listitem': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > li#listitem',
                  'snippet': '<li id="listitem">',
                  'explanation': 'Fix any of the following:\n  List item does not have a <ul>, <ol> parent element',
                  'nodeLabel': 'body > section > li#listitem',
                },
              },
            ],
          },
        },
        'meta-viewport': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'head > meta',
                  'snippet': '<meta name="viewport" content="user-scalable=no, maximum-scale=1.0">',
                  'explanation': 'Fix any of the following:\n  user-scalable=no on <meta> tag disables zooming on mobile devices',
                  'nodeLabel': 'head > meta',
                },
              },
            ],
          },
        },
        'object-alt': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > object#object-alt',
                  'snippet': '<object id="object-alt">',
                  'explanation': 'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist, references elements that do not exist or references elements that are empty\n  Element has no title attribute\n  Element\'s default semantics were not overridden with role="none" or role="presentation"',
                  'nodeLabel': 'body > section > object#object-alt',
                },
              },
            ],
          },
        },
        'tabindex': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > div#tabindex',
                  'snippet': '<div id="tabindex" tabindex="10">',
                  'explanation': 'Fix any of the following:\n  Element has a tabindex greater than 0',
                  'nodeLabel': 'body > section > div#tabindex',
                },
              },
            ],
          },
        },
        'td-headers-attr': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > table#td-headers-attr',
                  'snippet': '<table id="td-headers-attr">',
                  'explanation': 'Fix all of the following:\n  The headers attribute is not exclusively used to refer to other cells in the table',
                  'nodeLabel': 'FOO\nfoo',
                },
              },
            ],
          },
        },
        'valid-lang': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > p#valid-lang',
                  'snippet': '<p id="valid-lang" lang="foo">',
                  'explanation': 'Fix all of the following:\n  Value of lang attribute not included in the list of valid languages',
                  'nodeLabel': 'foo',
                },
              },
            ],
          },
        },
        'accesskeys': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  'type': 'node',
                  'selector': 'body > section > button#accesskeys1',
                  'snippet': '<button id="accesskeys1" accesskey="s">',
                  'explanation': 'Fix all of the following:\n  Document has multiple elements with the same accesskey',
                  'nodeLabel': 'Foo',
                },
              },
            ],
          },
        },
      },
    },
  },
];

module.exports = expectations;

},{}],8:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {LH.Config.Json}
 * Config file for running byte efficiency smokehouse audits.
 */
const config = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: [
      'accesskeys', // run axe on the page since we've had problems with interactions
      'network-requests',
      'offscreen-images',
      'uses-http2',
      'modern-image-formats',
      'uses-optimized-images',
      'uses-text-compression',
      'uses-responsive-images',
      'unminified-css',
      'unminified-javascript',
      'unused-css-rules',
      'unused-javascript',
      // image-size-responsive is not a byte-efficiency audit but a counterbalance to the byte-efficiency audits
      // that makes sense to test together.
      'image-size-responsive',
      // unsized-images is not a byte-efficiency audit but can easily leverage the variety of images present in
      // byte-efficiency tests & thus makes sense to test together.
      'unsized-images',
    ],
    throttlingMethod: 'devtools',
  },
  audits: [
    'unsized-images',
    {path: 'byte-efficiency/unused-javascript', options: {
      // Lower the threshold so we don't need huge resources to make a test.
      unusedThreshold: 2000,
    }},
  ],
};

module.exports = config;

},{}],9:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for byte efficiency tests
 */
const expectations = [
  {
    artifacts: {
      ScriptElements: [
        {
          type: null,
          src: null,
          async: false,
          defer: false,
          source: 'head',
          // Only do a single assertion for `devtoolsNodePath`: this can be flaky for elements
          // deep in the DOM, and the sample LHR test has plenty of places that would catch
          // a regression in `devtoolsNodePath` calculation. Keep just one for the benefit
          // of other smoke test runners.
          node: {
            devtoolsNodePath: '2,HTML,0,HEAD,3,SCRIPT',
          },
        },
        {
          type: 'application/javascript',
          src: 'http://localhost:10200/byte-efficiency/script.js',
          async: false,
          defer: false,
          source: 'head',
        },
        {
          type: null,
          src: 'http://localhost:10200/byte-efficiency/bundle.js',
          async: false,
          defer: false,
          source: 'head',
        },
        {
          type: null,
          src: null,
          async: false,
          defer: false,
          source: 'body',
          content: /shadowRoot/,
        },
        {
          type: null,
          src: null,
          async: false,
          defer: false,
          source: 'body',
          content: /generateInlineStyleWithSize/,
        },
        {
          type: null,
          src: null,
          async: false,
          defer: false,
          source: 'body',
          content: /Used block #1/,
        },
        {
          type: null,
          src: null,
          async: false,
          defer: false,
          source: 'body',
          content: /Unused block #1/,
        },
        {
          type: null,
          src: 'http://localhost:10200/byte-efficiency/delay-complete.js?delay=8000',
          async: true,
          defer: false,
          source: 'body',
        },
      ],
      JsUsage: {
        // ScriptParsedEvent.embedderName wasn't added to the protocol until M86,
        // and `some-custom-url.js` won't show without it.
        // https://chromiumdash.appspot.com/commit/52ed57138d0b83e8afd9de25e60655c6ace7527c
        '_minChromiumMilestone': 86,
        'http://localhost:10200/byte-efficiency/tester.html': [
          {url: 'http://localhost:10200/byte-efficiency/tester.html'},
          {url: 'http://localhost:10200/byte-efficiency/tester.html'},
          {url: 'http://localhost:10200/byte-efficiency/tester.html'},
          {url: 'http://localhost:10200/byte-efficiency/tester.html'},
          {url: '/some-custom-url.js'},
        ],
        'http://localhost:10200/byte-efficiency/script.js': [
          {url: 'http://localhost:10200/byte-efficiency/script.js'},
        ],
        'http://localhost:10200/byte-efficiency/bundle.js': [
          {url: 'http://localhost:10200/byte-efficiency/bundle.js'},
        ],
      },
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/byte-efficiency/tester.html',
      finalUrl: 'http://localhost:10200/byte-efficiency/tester.html',
      audits: {
        'uses-http2': {
          score: 1,
          details: {
            items: {
              // localhost gets a free pass on uses-h2
              length: 0,
            },
          },
        },
        'unminified-css': {
          details: {
            overallSavingsBytes: '>17000',
            items: {
              length: 2,
            },
          },
        },
        'unminified-javascript': {
          score: '<1',
          details: {
            // the specific ms value is not meaningful for this smoketest
            // *some largish amount* of savings should be reported
            overallSavingsMs: '>500',
            overallSavingsBytes: '>45000',
            items: [
              {
                url: 'http://localhost:10200/byte-efficiency/script.js',
                wastedBytes: '46481 +/- 100',
                wastedPercent: '87 +/- 5',
              },
              {
                url: 'inline: \n  function unusedFunction() {\n    // Un...',
                wastedBytes: '6700 +/- 100',
                wastedPercent: '99.6 +/- 0.1',
              },
              {
                url: 'inline: \n  // Used block #1\n  // FILLER DATA JUS...',
                wastedBytes: '6559 +/- 100',
                wastedPercent: 100,
              },
              {
                url: 'http://localhost:10200/byte-efficiency/bundle.js',
                totalBytes: '13000 +/- 1000',
                wastedBytes: '2350 +/- 100',
                wastedPercent: '19 +/- 5',
              },
            ],
          },
        },
        'unused-css-rules': {
          details: {
            overallSavingsBytes: '>40000',
            items: {
              length: 2,
            },
          },
        },
        'unused-javascript': {
          // ScriptParsedEvent.embedderName wasn't added to the protocol until M86.
          // https://chromiumdash.appspot.com/commit/52ed57138d0b83e8afd9de25e60655c6ace7527c
          _minChromiumMilestone: 86,
          score: '<1',
          details: {
            // the specific ms value here is not meaningful for this smoketest
            // *some* savings should be reported
            overallSavingsMs: '>0',
            overallSavingsBytes: '35000 +/- 1000',
            items: [
              {
                url: 'http://localhost:10200/byte-efficiency/script.js',
                totalBytes: '53000 +/- 1000',
                wastedBytes: '22000 +/- 1000',
              },
              {
                url: 'http://localhost:10200/byte-efficiency/tester.html',
                totalBytes: '15000 +/- 1000',
                wastedBytes: '6500 +/- 1000',
              },
              {
                url: 'http://localhost:10200/byte-efficiency/bundle.js',
                totalBytes: '12913 +/- 1000',
                wastedBytes: '5827 +/- 200',
                subItems: {
                  items: [
                    {source: '…./b.js', sourceBytes: '4417 +/- 50', sourceWastedBytes: '2191 +/- 50'},
                    {source: '…./c.js', sourceBytes: '2200 +/- 50', sourceWastedBytes: '2182 +/- 50'},
                    {source: '…webpack/bootstrap', sourceBytes: '2809 +/- 50', sourceWastedBytes: '1259 +/- 50'},
                  ],
                },
              },
            ],
          },
        },
        'offscreen-images': {
          details: {
            items: [
              {
                url: /lighthouse-unoptimized.jpg$/,
              }, {
                url: /lighthouse-480x320.webp$/,
              }, {
                url: /lighthouse-480x320.webp\?invisible$/,
              }, {
                url: /large.svg$/,
              },
            ],
          },
        },
        'modern-image-formats': {
          details: {
            overallSavingsBytes: '137000 +/- 10000',
            items: [
              {url: /lighthouse-1024x680.jpg$/},
              {url: /lighthouse-unoptimized.jpg$/},
              {url: /lighthouse-480x320.jpg$/},
              {url: /lighthouse-480x320.jpg\?attributesized/},
              {url: /lighthouse-480x320.jpg\?css/},
              {url: /lighthouse-480x320.jpg\?sprite/},
            ],
          },
        },
        'uses-text-compression': {
          score: '<1',
          details: {
            // the specific ms value is not meaningful for this smoketest
            // *some largish amount* of savings should be reported
            overallSavingsMs: '>700',
            overallSavingsBytes: '>50000',
            items: {
              length: 3,
            },
          },
        },
        'uses-optimized-images': {
          details: {
            overallSavingsBytes: '>10000',
            items: {
              length: 1,
            },
          },
        },
        // Check that images aren't TOO BIG.
        'uses-responsive-images': {
          details: {
            overallSavingsBytes: '113000 +/- 5000',
            items: [
              {wastedPercent: '56 +/- 5', url: /lighthouse-1024x680.jpg/},
              {wastedPercent: '78 +/- 5', url: /lighthouse-2048x1356.webp\?size0/},
              {wastedPercent: '56 +/- 5', url: /lighthouse-480x320.webp/},
              {wastedPercent: '20 +/- 5', url: /lighthouse-480x320.jpg/},
              {wastedPercent: '20 +/- 5', url: /lighthouse-480x320\.jpg\?attributesized/},
            ],
          },
        },
        // Checks that images aren't TOO SMALL.
        'image-size-responsive': {
          details: {
            items: [
              // One of these is the ?duplicate variant and another is the
              // ?cssauto variant but sort order isn't guaranteed
              // since the pixel diff is equivalent for identical images.
              {url: /lighthouse-320x212-poor.jpg/},
              {url: /lighthouse-320x212-poor.jpg/},
              {url: /lighthouse-320x212-poor.jpg/},
            ],
          },
        },
        'unsized-images': {
          details: {
            items: [
              {url: /lighthouse-320x212-poor\.jpg/},
              {url: /lighthouse-320x212-poor\.jpg\?cssauto/},
            ],
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/byte-efficiency/gzip.html',
      finalUrl: 'http://localhost:10200/byte-efficiency/gzip.html',
      audits: {
        'network-requests': {
          details: {
            items: [
              {
                url: 'http://localhost:10200/byte-efficiency/gzip.html',
                finished: true,
              },
              {
                url: 'http://localhost:10200/byte-efficiency/script.js?gzip=1',
                transferSize: '1200 +/- 150',
                resourceSize: '53000 +/- 1000',
                finished: true,
              },
              {
                url: 'http://localhost:10200/byte-efficiency/script.js',
                transferSize: '53200 +/- 1000',
                resourceSize: '53000 +/- 1000',
                finished: true,
              },
              {
                url: 'http://localhost:10200/favicon.ico',
                finished: true,
              },
            ],
          },
        },
      },
    },
  },
];

module.exports = expectations;

},{}],10:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {ReadonlyArray<Smokehouse.TestDfn>} */
const smokeTests = [{
  id: 'a11y',
  expectations: require('./a11y/expectations.js'),
  config: require('./a11y/a11y-config.js'),
}, {
  id: 'errors',
  expectations: require('./errors/error-expectations.js'),
  config: require('./errors/error-config.js'),
  runSerially: true,
}, {
  id: 'oopif',
  expectations: require('./oopif/oopif-expectations.js'),
  config: require('./oopif/oopif-config.js'),
}, {
  id: 'pwa',
  expectations: require('./pwa/pwa-expectations.js'),
  config: require('./pwa/pwa-config.js'),
}, {
  id: 'pwa2',
  expectations: require('./pwa/pwa2-expectations.js'),
  config: require('./pwa/pwa-config.js'),
}, {
  id: 'pwa3',
  expectations: require('./pwa/pwa3-expectations.js'),
  config: require('./pwa/pwa-config.js'),
}, {
  id: 'dbw',
  expectations: require('./dobetterweb/dbw-expectations.js'),
  config: require('./dobetterweb/dbw-config.js'),
  runSerially: true, // Need access to network request assertions.
}, {
  id: 'redirects',
  expectations: require('./redirects/expectations.js'),
  config: require('./redirects/redirects-config.js'),
}, {
  id: 'seo',
  expectations: require('./seo/expectations.js'),
  config: require('./seo/seo-config.js'),
}, {
  id: 'offline',
  expectations: require('./offline-local/offline-expectations.js'),
  config: require('./offline-local/offline-config.js'),
  runSerially: true,
}, {
  id: 'byte',
  expectations: require('./byte-efficiency/expectations.js'),
  config: require('./byte-efficiency/byte-config.js'),
  runSerially: true,
}, {
  id: 'perf',
  expectations: require('./perf/expectations.js'),
  config: require('./perf/perf-config.js'),
  runSerially: true,
}, {
  id: 'perf-diagnostics',
  expectations: require('./perf-diagnostics/expectations.js'),
  config: require('./perf-diagnostics/perf-diagnostics-config.js'),
}, {
  id: 'lantern',
  expectations: require('./lantern/lantern-expectations.js'),
  config: require('./lantern/lantern-config.js'),
}, {
  id: 'metrics',
  expectations: require('./tricky-metrics/expectations.js'),
  config: require('./tricky-metrics/no-throttling-config.js'),
}, {
  id: 'legacy-javascript',
  expectations: require('./legacy-javascript/expectations.js'),
  config: require('./legacy-javascript/legacy-javascript-config.js'),
}, {
  id: 'source-maps',
  expectations: require('./source-maps/expectations.js'),
  config: require('./source-maps/source-maps-config.js'),
}, {
// TODO: restore when --enable-features=AutofillShowTypePredictions is not needed.
//   id: 'forms',
//   expectations: require('./forms/form-expectations.js'),
//   config: require('./forms/form-config.js'),
// }, {
  id: 'screenshot',
  expectations: require('./screenshot/expectations.js'),
  config: require('./screenshot/screenshot-config.js'),
}, {
  id: 'csp',
  expectations: require('./csp/csp-expectations.js'),
  config: require('./csp/csp-config.js'),
}];

module.exports = smokeTests;

},{"./a11y/a11y-config.js":6,"./a11y/expectations.js":7,"./byte-efficiency/byte-config.js":8,"./byte-efficiency/expectations.js":9,"./csp/csp-config.js":11,"./csp/csp-expectations.js":12,"./dobetterweb/dbw-config.js":13,"./dobetterweb/dbw-expectations.js":14,"./errors/error-config.js":15,"./errors/error-expectations.js":16,"./lantern/lantern-config.js":17,"./lantern/lantern-expectations.js":18,"./legacy-javascript/expectations.js":19,"./legacy-javascript/legacy-javascript-config.js":20,"./offline-local/offline-config.js":21,"./offline-local/offline-expectations.js":22,"./oopif/oopif-config.js":23,"./oopif/oopif-expectations.js":24,"./perf-diagnostics/expectations.js":25,"./perf-diagnostics/perf-diagnostics-config.js":26,"./perf/expectations.js":27,"./perf/perf-config.js":28,"./pwa/pwa-config.js":29,"./pwa/pwa-expectations.js":31,"./pwa/pwa2-expectations.js":32,"./pwa/pwa3-expectations.js":33,"./redirects/expectations.js":34,"./redirects/redirects-config.js":35,"./screenshot/expectations.js":36,"./screenshot/screenshot-config.js":37,"./seo/expectations.js":38,"./seo/seo-config.js":39,"./source-maps/expectations.js":40,"./source-maps/source-maps-config.js":41,"./tricky-metrics/expectations.js":42,"./tricky-metrics/no-throttling-config.js":43}],11:[function(require,module,exports){
/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {LH.Config.Json} */
module.exports = {
  extends: 'lighthouse:default',
};

},{}],12:[function(require,module,exports){
/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @param {[string, string][]} headers
 * @return {string}
 */
function headersParam(headers) {
  const headerString = new URLSearchParams(headers).toString();
  return new URLSearchParams([['extra_header', headerString]]).toString();
}

// Only allow the empty script with the source map.
// Hash generated using https://strict-csp-codelab.glitch.me/csp_sha256_util.html
// Easiest way to get script contents with whitespace is by copying script node in DevTools.
const blockAllExceptInlineScriptCsp = headersParam([[
  'Content-Security-Policy',
  `default-src 'none'; script-src 'sha256-NCWlI90TxQpIfghtBWJyNU5Y92Nj8XhO+AYMm0gqGfQ='`,
]]);

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 */
module.exports = [
  {
    artifacts: {
      RobotsTxt: {
        status: 404,
        content: null,
      },
      InspectorIssues: {contentSecurityPolicy: []},
      SourceMaps: [{
        sourceMapUrl: 'http://localhost:10200/source-map/script.js.map',
        map: {},
        errorMessage: undefined,
      }],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/csp.html',
      finalUrl: 'http://localhost:10200/csp.html',
      audits: {},
    },
  },
  {
    artifacts: {
      _maxChromiumMilestone: 91,
      RobotsTxt: {
        status: null,
        content: null,
      },
      InspectorIssues: {
        contentSecurityPolicy: [
          {
            // https://github.com/GoogleChrome/lighthouse/issues/10225
            //
            // Fixed with new fetcher using M92.
            blockedURL: 'http://localhost:10200/robots.txt',
            violatedDirective: 'connect-src',
            isReportOnly: false,
            contentSecurityPolicyViolationType: 'kURLViolation',
          },
        ],
      },
      SourceMaps: [{
        // Doesn't trigger a CSP violation because iframe is injected after InspectorIssues gatherer finishes.
        // https://github.com/GoogleChrome/lighthouse/pull/12044#issuecomment-788274938
        //
        // Fixed with new fetcher using M92.
        sourceMapUrl: 'http://localhost:10200/source-map/script.js.map',
        errorMessage: 'Error: Timed out fetching resource.',
        map: undefined,
      }],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/csp.html?' + blockAllExceptInlineScriptCsp,
      finalUrl: 'http://localhost:10200/csp.html?' + blockAllExceptInlineScriptCsp,
      audits: {},
    },
  },
  {
    // Same CSP as above, but verifies correct behavior for M92.
    artifacts: {
      _minChromiumMilestone: 92,
      RobotsTxt: {
        status: 404,
        content: null,
      },
      InspectorIssues: {
        contentSecurityPolicy: [
        ],
      },
      SourceMaps: [{
        sourceMapUrl: 'http://localhost:10200/source-map/script.js.map',
        map: {},
        errorMessage: undefined,
      }],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/csp.html?' + blockAllExceptInlineScriptCsp,
      finalUrl: 'http://localhost:10200/csp.html?' + blockAllExceptInlineScriptCsp,
      audits: {},
    },
  },
];

},{}],13:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  audits: [
    // Test the `ignoredPatterns` audit option.
    {path: 'errors-in-console', options: {ignoredPatterns: ['An ignored error']}},
  ],
};

},{}],14:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for Do Better Web tests.
 */
const expectations = [
  {
    networkRequests: {
      // 50 requests made for normal page testing.
      // 6 extra requests made because stylesheets are evicted from the cache by the time DT opens.
      // 3 extra requests made to /dobetterweb/clock.appcache
      length: 59,
    },
    artifacts: {
      HostFormFactor: 'desktop',
      Stacks: [{
        id: 'jquery',
      }, {
        id: 'jquery-fast',
        name: 'jQuery (Fast path)',
      }, {
        id: 'wordpress',
      }],
      MainDocumentContent: /^<!doctype html>.*DoBetterWeb Mega Tester.*aggressive-promise-polyfill.*<\/html>[\r\n]*$/s,
      LinkElements: [
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=100',
          hrefRaw: './dbw_tester.css?delay=100',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/unknown404.css?delay=200',
          hrefRaw: './unknown404.css?delay=200',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=2200',
          hrefRaw: './dbw_tester.css?delay=2200',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_disabled.css?delay=200&isdisabled',
          hrefRaw: './dbw_disabled.css?delay=200&isdisabled',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&capped',
          hrefRaw: './dbw_tester.css?delay=3000&capped',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=2000&async=true',
          hrefRaw: './dbw_tester.css?delay=2000&async=true',
          hreflang: '',
          as: 'style',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&async=true',
          hrefRaw: './dbw_tester.css?delay=3000&async=true',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'alternate stylesheet',
          href: 'http://localhost:10200/dobetterweb/empty.css',
          hrefRaw: './empty.css',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
        {
          rel: 'stylesheet',
          href: 'http://localhost:10200/dobetterweb/dbw_tester.css?scriptActivated&delay=200',
          hrefRaw: './dbw_tester.css?scriptActivated&delay=200',
          hreflang: '',
          as: '',
          crossOrigin: null,
          source: 'head',
        },
      ],
      MetaElements: [
        {
          name: '',
          content: '',
          charset: 'utf-8',
        },
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1, minimum-scale=1',
        },
        {
          name: '',
          content: 'Open Graph smoke test description',
          property: 'og:description',
        },
      ],
      TagsBlockingFirstPaint: [
        {
          tag: {
            tagName: 'LINK',
            url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=100',
          },
        },
        {
          tag: {
            tagName: 'LINK',
            url: 'http://localhost:10200/dobetterweb/unknown404.css?delay=200',
          },
        },
        {
          tag: {
            tagName: 'LINK',
            url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=2200',
          },

        },
        {
          tag: {
            tagName: 'LINK',
            url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&capped',
            mediaChanges: [
              {
                href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&capped',
                media: 'not-matching',
                matches: false,
              },
              {
                href: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&capped',
                media: 'screen',
                matches: true,
              },
            ],
          },
        },
        {
          tag: {
            tagName: 'SCRIPT',
            url: 'http://localhost:10200/dobetterweb/dbw_tester.js',
          },
        },
        {
          tag: {
            tagName: 'SCRIPT',
            url: 'http://localhost:10200/dobetterweb/fcp-delayer.js?delay=5000',
          },
        },
      ],
      GlobalListeners: [{
        type: 'unload',
        scriptId: /^\d+$/,
        lineNumber: '>300',
        columnNumber: '>30',
      }],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/dobetterweb/dbw_tester.html',
      finalUrl: 'http://localhost:10200/dobetterweb/dbw_tester.html',
      audits: {
        'errors-in-console': {
          score: 0,
          details: {
            items: [
              {
                source: 'other',
                description: 'Application Cache Error event: Manifest fetch failed (404) http://localhost:10200/dobetterweb/clock.appcache',
                url: 'http://localhost:10200/dobetterweb/dbw_tester.html',
              },
              {
                source: 'exception',
                description: /^Error: A distinctive error\s+at http:\/\/localhost:10200\/dobetterweb\/dbw_tester.html:\d+:\d+$/,
                url: 'http://localhost:10200/dobetterweb/dbw_tester.html',
              },
              {
                source: 'console.error',
                description: 'Error! Error!',
                url: 'http://localhost:10200/dobetterweb/dbw_tester.html',
              },
              {
                source: 'network',
                description: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
                url: 'http://localhost:10200/dobetterweb/unknown404.css?delay=200',
              },
              {
                source: 'network',
                description: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
                url: 'http://localhost:10200/dobetterweb/fcp-delayer.js?delay=5000',
              },
              {
                source: 'network',
                description: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
                url: 'http://localhost:10200/favicon.ico',
              },
              {
                source: 'network',
                description: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
                url: 'http://localhost:10200/dobetterweb/unknown404.css?delay=200',
              },
            ],
          },
        },
        'is-on-https': {
          score: 0,
          details: {
            items: [
              {
                url: 'http://ajax.googleapis.com/ajax/libs/jquery/2.1.1/jquery.min.js',
                resolution: 'Allowed',
              },
            ],
          },
        },
        'external-anchors-use-rel-noopener': {
          score: 0,
          warnings: [/Unable to determine.*<a target="_blank">/],
          details: {
            items: {
              length: 3,
            },
          },
        },
        'appcache-manifest': {
          score: 0,
          displayValue: 'Found "clock.appcache"',
        },
        'geolocation-on-start': {
          score: 0,
        },
        'no-document-write': {
          score: 0,
          details: {
            items: {
              length: 3,
            },
          },
        },
        'no-vulnerable-libraries': {
          score: 0,
          details: {
            items: {
              length: 1,
            },
          },
        },
        'notification-on-start': {
          score: 0,
        },
        'render-blocking-resources': {
          score: '<1',
          numericValue: '>100',
          details: {
            items: [
              {
                url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=100',
              },
              {
                url: 'http://localhost:10200/dobetterweb/unknown404.css?delay=200',
              },
              {
                url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=2200',
              },
              {
                url: 'http://localhost:10200/dobetterweb/dbw_tester.css?delay=3000&capped',
              },
              {
                url: 'http://localhost:10200/dobetterweb/dbw_tester.js',
              },
              {
                url: 'http://localhost:10200/dobetterweb/fcp-delayer.js?delay=5000',
              },
            ],
          },
        },
        'uses-passive-event-listeners': {
          score: 0,
          details: {
            items: {
            // Note: Originally this was 7 but M56 defaults document-level
            // listeners to passive. See https://www.chromestatus.com/features/5093566007214080
            // Note: It was 4, but {passive:false} doesn't get a warning as of M63: https://crbug.com/770208
            // Note: It was 3, but wheel events are now also passive as of field trial in M71 https://crbug.com/626196
              length: '>=1',
            },
          },
        },
        'deprecations': {
          score: 0,
          details: {
            items: {
            // Note: HTML Imports added to deprecations in m70, so 3 before, 4 after.
              length: '>=3',
            },
          },
        },
        'password-inputs-can-be-pasted-into': {
          score: 0,
          details: {
            items: {
              length: 2,
            },
          },
        },
        'image-aspect-ratio': {
          score: 0,
          details: {
            items: {
              0: {
                displayedAspectRatio: /^120 x 15/,
                url: 'http://localhost:10200/dobetterweb/lighthouse-480x318.jpg?iar1',
              },
              length: 1,
            },
          },
        },
        'image-size-responsive': {
          score: 0,
          details: {
            items: {
              0: {
                url: 'http://localhost:10200/dobetterweb/lighthouse-480x318.jpg?isr1',
              },
              length: 1,
            },
          },
        },
        'efficient-animated-content': {
          score: '<0.5',
          details: {
            overallSavingsMs: '>2000',
            items: [
              {
                url: 'http://localhost:10200/dobetterweb/lighthouse-rotating.gif',
                totalBytes: 934285,
                wastedBytes: 682028,
              },
            ],
          },
        },
        'js-libraries': {
          score: 1,
          details: {
            items: [{
              name: 'jQuery',
            },
            {
              name: 'WordPress',
            }],
          },
        },
        'dom-size': {
          score: 1,
          numericValue: 149,
          details: {
            items: [
              {statistic: 'Total DOM Elements', value: 149},
              {statistic: 'Maximum DOM Depth', value: 4},
              {
                statistic: 'Maximum Child Elements',
                value: 100,
                node: {snippet: '<div id="shadow-root-container">'},
              },
            ],
          },
        },
        'no-unload-listeners': {
          score: 0,
          details: {
            items: [{
              source: {
                type: 'source-location',
                url: 'http://localhost:10200/dobetterweb/dbw_tester.html',
                urlProvider: 'network',
                line: '>300',
                column: '>30',
              },
            }],
          },
        },
        'full-page-screenshot': {
          score: null,
          details: {
            type: 'full-page-screenshot',
            screenshot: {
              width: 360,
              // Allow for differences in platforms.
              height: '1350±20',
              data: /^data:image\/jpeg;.{500,}/,
            },
            nodes: {
              'page-0-IMG': {
                // Test that these are numbers and in the ballpark.
                top: '650±50',
                bottom: '650±50',
                left: '10±10',
                right: '120±20',
                width: '120±20',
                height: '20±20',
              },
              // And then many more nodes.
            },
          },
        },
      },
    },
  },
  {
    artifacts: {
      InspectorIssues: {
        mixedContent: [
          {
            _minChromiumMilestone: 88, // We went from Warning to AutoUpgrade in https://chromium-review.googlesource.com/c/chromium/src/+/2480817
            resourceType: 'Image',
            resolutionStatus: 'MixedContentAutomaticallyUpgraded',
            insecureURL: 'http://www.mixedcontentexamples.com/Content/Test/steveholt.jpg',
            mainResourceURL: 'https://www.mixedcontentexamples.com/Test/NonSecureImage',
            request: {
              url: 'http://www.mixedcontentexamples.com/Content/Test/steveholt.jpg',
            },
          },
        ],
      },
    },
    lhr: {
      requestedUrl: 'https://www.mixedcontentexamples.com/Test/NonSecureImage',
      finalUrl: 'https://www.mixedcontentexamples.com/Test/NonSecureImage',
      audits: {
        'is-on-https': {
          score: 0,
        },
      },
    },
  },
];

module.exports = expectations;

},{}],15:[function(require,module,exports){
/**
 * @license Copyright 2018 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for sites with various errors, just fail out quickly.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    maxWaitForLoad: 5000,
    onlyAudits: [
      'first-contentful-paint',
    ],
  },
};

},{}],16:[function(require,module,exports){
/**
 * @license Copyright 2018 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

// Just using `[]` actually asserts for an empty array.
// Use this expectation object to assert an array with at least one element.
const NONEMPTY_ARRAY = {
  length: '>0',
};

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for sites with various errors.
 */
const expectations = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/infinite-loop.html',
      finalUrl: 'http://localhost:10200/infinite-loop.html',
      runtimeError: {code: 'PAGE_HUNG'},
      runWarnings: ['Lighthouse was unable to reliably load the URL you requested because the page stopped responding.'],
      audits: {
        'first-contentful-paint': {
          scoreDisplayMode: 'error',
          errorMessage: 'Required traces gatherer did not run.',
        },
      },
    },
    artifacts: {
      PageLoadError: {code: 'PAGE_HUNG'},
      devtoolsLogs: {
        'pageLoadError-defaultPass': NONEMPTY_ARRAY,
      },
      traces: {
        'pageLoadError-defaultPass': {traceEvents: NONEMPTY_ARRAY},
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'https://expired.badssl.com',
      finalUrl: 'https://expired.badssl.com/',
      runtimeError: {code: 'INSECURE_DOCUMENT_REQUEST'},
      runWarnings: ['The URL you have provided does not have a valid security certificate. net::ERR_CERT_DATE_INVALID'],
      audits: {
        'first-contentful-paint': {
          scoreDisplayMode: 'error',
          errorMessage: 'Required traces gatherer did not run.',
        },
      },
    },
    artifacts: {
      PageLoadError: {code: 'INSECURE_DOCUMENT_REQUEST'},
      devtoolsLogs: {
        'pageLoadError-defaultPass': NONEMPTY_ARRAY,
      },
      traces: {
        'pageLoadError-defaultPass': {traceEvents: NONEMPTY_ARRAY},
      },
    },
  },
  {
    lhr: {
      // Our interstitial error handling used to be quite aggressive, so we'll test a page
      // that has a bad iframe to make sure LH audits successfully.
      // https://github.com/GoogleChrome/lighthouse/issues/9562
      requestedUrl: 'http://localhost:10200/badssl-iframe.html',
      finalUrl: 'http://localhost:10200/badssl-iframe.html',
      audits: {
        'first-contentful-paint': {
          scoreDisplayMode: 'numeric',
        },
      },
    },
    artifacts: {
      devtoolsLogs: {
        defaultPass: NONEMPTY_ARRAY,
      },
      traces: {
        defaultPass: {traceEvents: NONEMPTY_ARRAY},
      },
    },
  },
];

module.exports = expectations;

},{}],17:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running byte efficiency smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
    precomputedLanternData: {
      additionalRttByOrigin: {
        'http://localhost:10200': 500,
      },
      serverResponseTimeByOrigin: {
        'http://localhost:10200': 1000,
      },
    },
  },
};

},{}],18:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for lantern smoketests
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/online-only.html',
      finalUrl: 'http://localhost:10200/online-only.html',
      audits: {
        'first-contentful-paint': {
          numericValue: '>2000',
        },
        'interactive': {
          numericValue: '>2000',
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/tricky-main-thread.html?setTimeout',
      finalUrl: 'http://localhost:10200/tricky-main-thread.html?setTimeout',
      audits: {
        'interactive': {
          // Make sure all of the CPU time is reflected in the perf metrics as well.
          // The scripts stalls for 3 seconds and lantern has a 4x multiplier so 12s minimum.
          numericValue: '>12000',
        },
        'bootup-time': {
          details: {
            items: {
              0: {
                url: /main-thread-consumer/,
                scripting: '>1000',
              },
            },
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/tricky-main-thread.html?fetch',
      finalUrl: 'http://localhost:10200/tricky-main-thread.html?fetch',
      audits: {
        'interactive': {
          // Make sure all of the CPU time is reflected in the perf metrics as well.
          // The scripts stalls for 3 seconds and lantern has a 4x multiplier so 12s minimum.
          numericValue: '>12000',
        },
        'bootup-time': {
          details: {
            items: {
              0: {
              // TODO: requires sampling profiler and async stacks, see https://github.com/GoogleChrome/lighthouse/issues/8526
              // url: /main-thread-consumer/,
                scripting: '>1000',
              },
            },
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/tricky-main-thread.html?xhr',
      finalUrl: 'http://localhost:10200/tricky-main-thread.html?xhr',
      audits: {
        'interactive': {
          // Make sure all of the CPU time is reflected in the perf metrics as well.
          // The scripts stalls for 3 seconds and lantern has a 4x multiplier so 12s minimum.
          numericValue: '>12000',
        },
        'bootup-time': {
          details: {
            items: {
              0: {
                url: /main-thread-consumer/,
                scripting: '>9000',
              },
            },
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/ric-shim.html?short',
      finalUrl: 'http://localhost:10200/ric-shim.html?short',
      audits: {
        'total-blocking-time': {
          // With the requestIdleCallback shim in place 1ms tasks should not block at all and should max add up to
          // 12.5 ms each, which would result in 50ms under a 4x simulated throttling multiplier and therefore in 0 tbt
          numericValue: '<=100',
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/ric-shim.html?long',
      finalUrl: 'http://localhost:10200/ric-shim.html?long',
      audits: {
        'total-blocking-time': {
          // With a 4x throttling multiplier in place each 50ms task takes 200ms, which results in 150ms blocking time
          // each. We iterate ~40 times, so the true amount of blocking time we expect is ~6s, but
          // sometimes Chrome's requestIdleCallback won't fire the full 40 if the machine is under load,
          // so be generous with how much slack to give in the expectations.
          numericValue: '>2500',
        },
      },
    },
  },
];

},{}],19:[function(require,module,exports){
/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Expected Lighthouse audit values for sites with polyfills.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/legacy-javascript.html',
      finalUrl: 'http://localhost:10200/legacy-javascript.html',
      audits: {
        'legacy-javascript': {
          details: {
            items: [
              {
                url: 'http://localhost:10200/legacy-javascript.js',
                wastedBytes: '78000 +/- 2000',
                subItems: {
                  items: [
                    {signal: 'Array.prototype.fill'},
                    {signal: 'Array.prototype.filter'},
                    {signal: 'Array.prototype.findIndex'},
                    {signal: 'Array.prototype.find'},
                    {signal: 'Array.prototype.forEach'},
                    {signal: 'Array.from'},
                    {signal: 'Array.prototype.includes'},
                    {signal: 'Array.isArray'},
                    {signal: 'Array.prototype.map'},
                    {signal: 'Array.of'},
                    {signal: 'Array.prototype.reduceRight'},
                    {signal: 'Array.prototype.reduce'},
                    {signal: 'Array.prototype.some'},
                    {signal: 'Date.now'},
                    {signal: 'Date.prototype.toISOString'},
                    {signal: 'Date.prototype.toJSON'},
                    {signal: 'Number.isInteger'},
                    {signal: 'Number.isSafeInteger'},
                    {signal: 'Number.parseInt'},
                    {signal: 'Object.defineProperties'},
                    {signal: 'Object.defineProperty'},
                    {signal: 'Object.entries'},
                    {signal: 'Object.freeze'},
                    {signal: 'Object.getOwnPropertyDescriptors'},
                    {signal: 'Object.getOwnPropertyNames'},
                    {signal: 'Object.getPrototypeOf'},
                    {signal: 'Object.isExtensible'},
                    {signal: 'Object.isFrozen'},
                    {signal: 'Object.isSealed'},
                    {signal: 'Object.keys'},
                    {signal: 'Object.preventExtensions'},
                    {signal: 'Object.seal'},
                    {signal: 'Object.setPrototypeOf'},
                    {signal: 'Object.values'},
                    {signal: 'Reflect.apply'},
                    {signal: 'Reflect.construct'},
                    {signal: 'Reflect.defineProperty'},
                    {signal: 'Reflect.deleteProperty'},
                    {signal: 'Reflect.getOwnPropertyDescriptor'},
                    {signal: 'Reflect.getPrototypeOf'},
                    {signal: 'Reflect.get'},
                    {signal: 'Reflect.has'},
                    {signal: 'Reflect.isExtensible'},
                    {signal: 'Reflect.ownKeys'},
                    {signal: 'Reflect.preventExtensions'},
                    {signal: 'Reflect.setPrototypeOf'},
                    {signal: 'String.prototype.codePointAt'},
                    {signal: 'String.fromCodePoint'},
                    {signal: 'String.raw'},
                    {signal: 'String.prototype.repeat'},
                    {signal: '@babel/plugin-transform-classes'},
                    {signal: '@babel/plugin-transform-regenerator'},
                    {signal: '@babel/plugin-transform-spread'},
                  ],
                },
              },
              {
                url: 'http://localhost:10200/legacy-javascript.html',
                subItems: {
                  items: [
                    {signal: 'Array.prototype.findIndex'},
                  ],
                },
              },
            ],
          },
        },
      },
    },
  },
];

},{}],20:[function(require,module,exports){
/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: [
      'performance',
    ],
    onlyAudits: [
      'legacy-javascript',
    ],
  },
};

},{}],21:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: [
      'best-practices',
    ],
    onlyAudits: [
      'is-on-https',
      'redirects-http',
      'service-worker',
      'viewport',
      'user-timings',
      'critical-request-chains',
      'render-blocking-resources',
      'installable-manifest',
      'splash-screen',
      'themed-omnibox',
      'aria-valid-attr',
      'aria-allowed-attr',
      'color-contrast',
      'image-alt',
      'label',
      'tabindex',
      'content-width',
    ],
  },
};

},{}],22:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse results from testing the defaut audits on local test
 * pages, one of which works offline with a service worker and one of which does
 * not.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/online-only.html',
      finalUrl: 'http://localhost:10200/online-only.html',
      audits: {
        'is-on-https': {
          score: 1,
        },
        'external-anchors-use-rel-noopener': {
          score: 1,
        },
        'appcache-manifest': {
          score: 1,
        },
        'geolocation-on-start': {
          score: 1,
        },
        'render-blocking-resources': {
          score: 1,
        },
        'password-inputs-can-be-pasted-into': {
          score: 1,
        },
        'redirects-http': {
          score: null,
          scoreDisplayMode: 'notApplicable',
        },
        'service-worker': {
          score: 0,
        },
        'viewport': {
          score: 1,
        },
        'user-timings': {
          scoreDisplayMode: 'notApplicable',
        },
        'critical-request-chains': {
          scoreDisplayMode: 'notApplicable',
        },
        'installable-manifest': {
          score: 0,
          details: {items: [{reason: 'No manifest was fetched'}]},
        },
        'splash-screen': {
          score: 0,
        },
        'themed-omnibox': {
          score: 0,
        },
        'aria-valid-attr': {
          scoreDisplayMode: 'notApplicable',
        },
        'aria-allowed-attr': {
          scoreDisplayMode: 'notApplicable',
        },
        'color-contrast': {
          score: 1,
        },
        'image-alt': {
          scoreDisplayMode: 'notApplicable',
        },
        'label': {
          scoreDisplayMode: 'notApplicable',
        },
        'tabindex': {
          scoreDisplayMode: 'notApplicable',
        },
        'content-width': {
          score: 1,
        },
      },
    },
  },
  {
    artifacts: {
      WebAppManifest: {
        value: {
          icons: {
            value: [
              {value: {src: {value: 'http://localhost:10503/launcher-icon-0-75x.png'}}},
              {value: {src: {value: 'http://localhost:10503/launcher-icon-1x.png'}}},
              {value: {src: {value: 'http://localhost:10503/launcher-icon-1-5x.png'}}},
              {value: {src: {value: 'http://localhost:10503/launcher-icon-2x.png'}}},
              {value: {src: {value: 'http://localhost:10503/launcher-icon-3x.png'}}},
            ],
          },
        },
      },
      InstallabilityErrors: {
        errors: {
          length: 1,
          0: {
            // For a few days in m89, the warn-not-offline-capable error also showed up here.
            // https://github.com/GoogleChrome/lighthouse/issues/11800
            errorId: /no-icon-available/,
          },
        },
      },
    },
    lhr: {
      requestedUrl: 'http://localhost:10503/offline-ready.html',
      finalUrl: 'http://localhost:10503/offline-ready.html',
      audits: {
        'is-on-https': {
          score: 1,
        },
        'redirects-http': {
          score: null,
          scoreDisplayMode: 'notApplicable',
        },
        'service-worker': {
          score: 1,
          details: {
            scriptUrl: 'http://localhost:10503/offline-ready-sw.js',
            scopeUrl: 'http://localhost:10503/',
          },
        },
        'viewport': {
          score: 1,
        },
        'user-timings': {
          scoreDisplayMode: 'notApplicable',
        },
        'critical-request-chains': {
          scoreDisplayMode: 'notApplicable',
        },
        'installable-manifest': {
          score: 0,
          details: {items: [{reason: 'Downloaded icon was empty or corrupted'}]},
        },
        'splash-screen': {
          score: 0,
        },
        'themed-omnibox': {
          score: 0,
        },
        'aria-valid-attr': {
          scoreDisplayMode: 'notApplicable',
        },
        'aria-allowed-attr': {
          scoreDisplayMode: 'notApplicable',
        },
        'color-contrast': {
          score: 1,
        },
        'image-alt': {
          score: 0,
        },
        'label': {
          scoreDisplayMode: 'notApplicable',
        },
        'tabindex': {
          scoreDisplayMode: 'notApplicable',
        },
        'content-width': {
          score: 1,
        },
      },
    },
  },

  {
    lhr: {
      requestedUrl: 'http://localhost:10503/offline-ready.html?broken',
      // This page's SW has a `fetch` handler that doesn't provide a 200 response.
      finalUrl: 'http://localhost:10503/offline-ready.html?broken',
      audits: {
        'installable-manifest': {
          score: 0,
          details: {items: {length: 1}},
          // TODO: 'warn-not-offline-capable' was disabled in m91. Turn back on once
          // issues are addressed and check is re-enabled: https://crbug.com/1187668#c22
          // warnings: {length: 1},
        },
      },
    },
    artifacts: {
      InstallabilityErrors: {
        // COMPAT: `warn-not-offline-capable` occurs in m89 but may be cherry-picked out of m90.
        _minChromiumMilestone: 91,
        errors: {
          length: 1,
          // 0: {
          //   errorId: /warn-not-offline-capable/,
          // },
          0: {
            errorId: /no-icon-available/,
          },
        },
      },
    },
  },

  {
    lhr: {
      requestedUrl: 'http://localhost:10503/offline-ready.html?slow',
      finalUrl: 'http://localhost:10503/offline-ready.html?slow',
      audits: {
        'service-worker': {
          score: 1,
          details: {
            scriptUrl: 'http://localhost:10503/offline-ready-sw.js?delay=5000&slow',
            scopeUrl: 'http://localhost:10503/',
          },
        },
      },
    },
  },
];

},{}],23:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {LH.Config.Json}
 * Config file for running the OOPIF tests
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    // This test runs in CI and hits the outside network of a live site.
    // Be a little more forgiving on how long it takes all network requests of several nested iframes
    // to complete.
    maxWaitForLoad: 180000,
  },
  passes: [
    // CI machines are pretty weak which lead to many more long tasks than normal.
    // Reduce our requirement for CPU quiet.
    {
      passName: 'defaultPass',
      cpuQuietThresholdMs: 500,
    },
  ],
};

},{}],24:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for sites with OOPIFS.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/oopif.html',
      finalUrl: 'http://localhost:10200/oopif.html',
      audits: {
        'network-requests': {
          details: {
            items: {
            // We want to make sure we are finding the iframe's requests (paulirish.com) *AND*
            // the iframe's iframe's iframe's requests (youtube.com/doubleclick/etc).
            // - paulirish.com ~40-60 requests
            // - paulirish.com + all descendant iframes ~80-90 requests
              length: '>70',
            },
          },
        },
      },
    },
    artifacts: {
      IFrameElements: [
        {
          id: 'oopif',
          src: 'https://www.paulirish.com/2012/why-moving-elements-with-translate-is-better-than-posabs-topleft/',
          clientRect: {
            width: '>0',
            height: '>0',
          },
          isPositionFixed: false,
        },
        {
          id: 'outer-iframe',
          src: 'http://localhost:10200/online-only.html',
          clientRect: {
            width: '>0',
            height: '>0',
          },
          isPositionFixed: true,
        },
      ],
    },
  },
];

},{}],25:[function(require,module,exports){
/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for perf diagnostics tests which do not need to be run serially.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/animations.html',
      finalUrl: 'http://localhost:10200/perf/animations.html',
      audits: {
        'non-composited-animations': {
          // Requires compositor failure reasons to be in the trace
          // https://chromiumdash.appspot.com/commit/995baabedf9e70d16deafc4bc37a2b215a9b8ec9
          _minChromiumMilestone: 86,
          score: null,
          displayValue: '1 animated element found',
          details: {
            items: [
              {
                node: {
                  type: 'node',
                  path: '2,HTML,1,BODY,1,DIV',
                  selector: 'body > div#animated-boi',
                  nodeLabel: 'This is changing font size',
                  snippet: '<div id="animated-boi">',
                },
                subItems: {
                  items: [
                    {
                      // From JavaScript `.animate` which has no animation display name
                      failureReason: 'Unsupported CSS Property: width',
                    },
                    {
                      failureReason: 'Unsupported CSS Property: height',
                      animation: 'alpha',
                    },
                    {
                      failureReason: 'Unsupported CSS Property: font-size',
                      animation: 'beta',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/third-party.html',
      finalUrl: 'http://localhost:10200/perf/third-party.html',
      audits: {
        'third-party-facades': {
          score: 0,
          displayValue: '1 facade alternative available',
          details: {
            items: [
              {
                product: 'YouTube Embedded Player (Video)',
                blockingTime: 0, // Note: Only 0 if the iframe was out-of-process
                transferSize: '>400000', // Transfer size is imprecise.
                subItems: {
                  type: 'subitems',
                  items: {
                    length: '>5', // We don't care exactly how many it has, just ensure we surface the subresources.
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/unsized-images.html',
      finalUrl: 'http://localhost:10200/perf/unsized-images.html',
      audits: {
        'unsized-images': {
          score: 0,
          details: {
            items: [
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" width="100">',
                },
              },
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" height="100">',
                },
              },
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" style="width: 100;">',
                },
              },
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" style="height: 100;">',
                },
              },
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" style="aspect-ratio: 1 / 1;">',
                },
              },
              {
                node: {
                  snippet: '<img src="../launcher-icon-100x100.png" style="width: 100; height: auto;">',
                },
              },
            ],
          },
        },
      },
    },
  },
];

},{}],26:[function(require,module,exports){
/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {LH.Config.Json} */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
  },
};

},{}],27:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for perf tests.
 */
module.exports = [
  {
    networkRequests: {
      // 8 requests made for normal page testing.
      // 1 extra request made because stylesheets are evicted from the cache by the time DT opens.
      length: 9,
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/preload.html',
      finalUrl: 'http://localhost:10200/preload.html',
      audits: {
        'speed-index': {
          score: '>=0.80', // primarily just making sure it didn't fail/go crazy, specific value isn't that important
        },
        'first-meaningful-paint': {
          score: '>=0.90', // primarily just making sure it didn't fail/go crazy, specific value isn't that important
        },
        'interactive': {
          score: '>=0.90', // primarily just making sure it didn't fail/go crazy, specific value isn't that important
        },
        'server-response-time': {
          // Can be flaky, so test float numericValue instead of binary score
          numericValue: '<1000',
        },
        'network-requests': {
          details: {
            items: {
              length: '>5',
            },
          },
        },
        'uses-rel-preload': {
          scoreDisplayMode: 'notApplicable',
          // Disabled for now, see https://github.com/GoogleChrome/lighthouse/issues/11960
          // score: '<1',
          // numericValue: '>500',
          // warnings: {
          //   0: /level-2.*warning/,
          //   length: 1,
          // },
          // details: {
          //   items: {
          //     length: 1,
          //   },
          // },
        },
        'uses-rel-preconnect': {
          score: 1,
          warnings: {
            0: /fonts.googleapis/,
            length: 1,
          },
        },
      },
    },
  },
  {
    networkRequests: {
      length: 8,
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/perf-budgets/load-things.html',
      finalUrl: 'http://localhost:10200/perf/perf-budgets/load-things.html',
      audits: {
        'resource-summary': {
          score: null,
          displayValue: '10 requests • 164 KiB',
          details: {
            items: [
              {resourceType: 'total', requestCount: 10, transferSize: '168000±1000'},
              {resourceType: 'font', requestCount: 2, transferSize: '81000±1000'},
              {resourceType: 'script', requestCount: 3, transferSize: '55000±1000'},
              {resourceType: 'image', requestCount: 2, transferSize: '28000±1000'},
              {resourceType: 'document', requestCount: 1, transferSize: '2200±150'},
              {resourceType: 'other', requestCount: 1, transferSize: '1030±100'},
              {resourceType: 'stylesheet', requestCount: 1, transferSize: '450±100'},
              {resourceType: 'media', requestCount: 0, transferSize: 0},
              {resourceType: 'third-party', requestCount: 0, transferSize: 0},
            ],
          },
        },
        'performance-budget': {
          score: null,
          details: {
            // Undefined items are asserting that the property isn't included in the table item.
            items: [
              {
                resourceType: 'total',
                countOverBudget: '2 requests',
                sizeOverBudget: '65000±1000',
              },
              {
                resourceType: 'script',
                countOverBudget: '2 requests',
                sizeOverBudget: '25000±1000',
              },
              {
                resourceType: 'font',
                countOverBudget: undefined,
                sizeOverBudget: '4000±500',
              },
              {
                resourceType: 'document',
                countOverBudget: '1 request',
                sizeOverBudget: '1200±50',
              },
              {
                resourceType: 'stylesheet',
                countOverBudget: undefined,
                sizeOverBudget: '450±100',
              },
              {
                resourceType: 'image',
                countOverBudget: '1 request',
                sizeOverBudget: undefined,
              },
              {
                resourceType: 'media',
                countOverBudget: undefined,
                sizeOverBudget: undefined,
              },
              {
                resourceType: 'other',
                countOverBudget: undefined,
                sizeOverBudget: undefined,
              },
              {
                resourceType: 'third-party',
                countOverBudget: undefined,
                sizeOverBudget: undefined,
              },
            ],
          },
        },
      },
    },
  },
  {
    networkRequests: {
      length: 5,
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/fonts.html',
      finalUrl: 'http://localhost:10200/perf/fonts.html',
      audits: {
        'font-display': {
          score: 0,
          details: {
            items: [
              {
                url: 'http://localhost:10200/perf/lobster-v20-latin-regular.woff2',
              },
            ],
          },
        },
        'preload-fonts': {
          scoreDisplayMode: 'notApplicable',
          // Disabled for now, see https://github.com/GoogleChrome/lighthouse/issues/11960
          // score: 0,
          // details: {
          //   items: [
          //     {
          //       url: 'http://localhost:10200/perf/lobster-two-v10-latin-700.woff2?delay=1000',
          //     },
          //   ],
          // },
        },
      },
    },
  },
  {
    networkRequests: {
      length: 3,
    },
    artifacts: {
      TraceElements: [
        {
          traceEventType: 'largest-contentful-paint',
          node: {
            nodeLabel: 'section > img',
            snippet: '<img src="../dobetterweb/lighthouse-480x318.jpg">',
            boundingRect: {
              top: 108,
              bottom: 426,
              left: 8,
              right: 488,
              width: 480,
              height: 318,
            },
          },
        },
        {
          traceEventType: 'layout-shift',
          node: {
            selector: 'body > h1',
            nodeLabel: 'Please don\'t move me',
            snippet: '<h1>',
            boundingRect: {
              top: 465,
              bottom: 502,
              left: 8,
              right: 352,
              width: 344,
              height: 37,
            },
          },
          score: '0.058 +/- 0.01',
        },
        {
          traceEventType: 'layout-shift',
          node: {
            nodeLabel: 'Sorry!',
            snippet: '<div style="height: 18px;">',
            boundingRect: {
              top: 426,
              bottom: 444,
              left: 8,
              right: 352,
              width: 344,
              height: 18,
            },
          },
          score: '0.026 +/- 0.01',
        },
        {
          // Requires compositor failure reasons to be in the trace
          // for `failureReasonsMask` and `unsupportedProperties`
          // https://chromiumdash.appspot.com/commit/995baabedf9e70d16deafc4bc37a2b215a9b8ec9
          _minChromiumMilestone: 86,
          traceEventType: 'animation',
          node: {
            selector: 'body > div#animate-me',
            nodeLabel: 'This is changing font size',
            snippet: '<div id="animate-me">',
            boundingRect: {
              top: 8,
              bottom: 108,
              left: 8,
              right: 108,
              width: 100,
              height: 100,
            },
          },
          animations: [
            {
              name: 'anim',
              failureReasonsMask: 8224,
              unsupportedProperties: ['font-size'],
            },
          ],
        },
      ],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/trace-elements.html',
      finalUrl: 'http://localhost:10200/perf/trace-elements.html',
      audits: {
        'largest-contentful-paint-element': {
          score: null,
          displayValue: '1 element found',
          details: {
            items: [
              {
                node: {
                  type: 'node',
                  nodeLabel: 'section > img',
                  path: '0,HTML,1,BODY,1,DIV,a,#document-fragment,0,SECTION,0,IMG',
                },
              },
            ],
          },
        },
        'layout-shift-elements': {
          score: null,
          displayValue: '2 elements found',
          details: {
            items: {
              length: 2,
            },
          },
        },
        'long-tasks': {
          score: null,
          details: {
            items: {
              0: {
                url: 'http://localhost:10200/perf/delayed-element.js',
                duration: '>500',
                startTime: '5000 +/- 5000', // make sure it's on the right time scale, but nothing more
              },
            },
          },
        },
      },
    },
  },
  {
    networkRequests: {
      length: 2,
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/perf/frame-metrics.html',
      finalUrl: 'http://localhost:10200/perf/frame-metrics.html',
      audits: {
        'metrics': {
          score: null,
          details: {
            type: 'debugdata',
            items: [
              {
                // Weighted CLS score was added to the trace in m90:
                // https://bugs.chromium.org/p/chromium/issues/detail?id=1173139
                //
                // Weighted score on emulated mobile bug fixed in m92:
                // https://chromium.googlesource.com/chromium/src/+/042fbfb4cc6a675da0dff4bf3fc08622af42422b
                _minChromiumMilestone: 92,
                firstContentfulPaint: '>5000',
                firstContentfulPaintAllFrames: '<5000',
                largestContentfulPaint: '>5000',
                largestContentfulPaintAllFrames: '<5000',
                cumulativeLayoutShift: '0.197 +/- 0.001',
                cumulativeLayoutShiftMainFrame: '0.001 +/- 0.0005',
                totalCumulativeLayoutShift: '0.001 +/- 0.0005',
              },
              {
                lcpInvalidated: false,
              },
            ],
          },
        },
      },
    },
  },
];

},{}],28:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {LH.Config.Json} */
const perfConfig = {
  extends: 'lighthouse:default',
  settings: {
    throttlingMethod: 'devtools',
    // preload-fonts isn't a performance audit, but can easily leverage the font
    // webpages present here, hence the inclusion of 'best-practices'.
    onlyCategories: ['performance', 'best-practices'],

    // A mixture of under, over, and meeting budget to exercise all paths.
    budgets: [{
      path: '/',
      resourceCounts: [
        {resourceType: 'total', budget: 8},
        {resourceType: 'stylesheet', budget: 1}, // meets budget
        {resourceType: 'image', budget: 1},
        {resourceType: 'media', budget: 0},
        {resourceType: 'font', budget: 2}, // meets budget
        {resourceType: 'script', budget: 1},
        {resourceType: 'document', budget: 0},
        {resourceType: 'other', budget: 1},
        {resourceType: 'third-party', budget: 0},
      ],
      resourceSizes: [
        {resourceType: 'total', budget: 100},
        {resourceType: 'stylesheet', budget: 0},
        {resourceType: 'image', budget: 30}, // meets budget
        {resourceType: 'media', budget: 0},
        {resourceType: 'font', budget: 75},
        {resourceType: 'script', budget: 30},
        {resourceType: 'document', budget: 1},
        {resourceType: 'other', budget: 2}, // meets budget
        {resourceType: 'third-party', budget: 0},
      ],
      timings: [
        {metric: 'first-contentful-paint', budget: 2000},
        {metric: 'interactive', budget: 2000},
        {metric: 'first-meaningful-paint', budget: 2000},
        {metric: 'max-potential-fid', budget: 2000},
      ],
    }],
  },
};

module.exports = perfConfig;

},{}],29:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['pwa'],
  },
};

},{}],30:[function(require,module,exports){
/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

module.exports = {
  isParseFailure: false,
  hasStartUrl: true,
  hasIconsAtLeast144px: true,
  hasIconsAtLeast512px: true,
  hasPWADisplayValue: true,
  hasBackgroundColor: true,
  hasThemeColor: true,
  hasShortName: true,
  hasName: true,
};

},{}],31:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const pwaDetailsExpectations = require('./pwa-expectations-details.js');

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for various sites with stable(ish) PWA
 * results.
 */
const expectations = [
  {
    lhr: {
      requestedUrl: 'https://airhorner.com',
      finalUrl: 'https://airhorner.com/',
      audits: {
        'redirects-http': {
          score: 1,
        },
        'service-worker': {
          score: 1,
        },
        'viewport': {
          score: 1,
        },
        'installable-manifest': {
          score: 1,
          details: {items: [], debugData: {manifestUrl: 'https://airhorner.com/manifest.json'}},
        },
        'splash-screen': {
          score: 1,
          details: {items: [pwaDetailsExpectations]},
        },
        'themed-omnibox': {
          score: 1,
          details: {items: [{...pwaDetailsExpectations, themeColor: '#2196F3'}]},
        },
        'content-width': {
          score: 1,
        },
        'apple-touch-icon': {
          score: 1,
        },

        // "manual" audits. Just verify in the results.
        'pwa-cross-browser': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-page-transitions': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-each-page-has-url': {
          score: null,
          scoreDisplayMode: 'manual',
        },
      },
    },
  },

  {
    lhr: {
      requestedUrl: 'https://www.chromestatus.com/features',
      finalUrl: 'https://www.chromestatus.com/features',
      audits: {
        'redirects-http': {
          score: 1,
        },
        'service-worker': {
          score: 0,
        },
        'viewport': {
          score: 1,
        },
        'installable-manifest': {
          score: 0,
          details: {items: [{reason: 'No manifest was fetched'}]},
        },
        'splash-screen': {
          score: 0,
        },
        'themed-omnibox': {
          score: 0,
        },
        'content-width': {
          score: 1,
        },
        'apple-touch-icon': {
          score: 1,
        },

        // "manual" audits. Just verify in the results.
        'pwa-cross-browser': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-page-transitions': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-each-page-has-url': {
          score: null,
          scoreDisplayMode: 'manual',
        },
      },
    },
  },
];

module.exports = expectations;

},{"./pwa-expectations-details.js":30}],32:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const pwaDetailsExpectations = require('./pwa-expectations-details.js');
const jakeExpectations = {...pwaDetailsExpectations, hasShortName: false};

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for various sites with stable(ish) PWA
 * results.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'https://jakearchibald.github.io/svgomg/',
      finalUrl: 'https://jakearchibald.github.io/svgomg/',
      audits: {
        'redirects-http': {
          score: 1,
        },
        'service-worker': {
          score: 1,
        },
        'viewport': {
          score: 1,
        },
        'installable-manifest': {
          score: 1,
          details: {items: [], debugData: {manifestUrl: 'https://jakearchibald.github.io/svgomg/manifest.json'}},
        },
        'splash-screen': {
          score: 1,
          details: {items: [jakeExpectations]},
        },
        'themed-omnibox': {
          score: 1,
          details: {items: [jakeExpectations]},
        },
        'content-width': {
          score: 1,
        },
        'apple-touch-icon': {
          score: 1,
          warnings: [
            /apple-touch-icon-precomposed/,
          ],
        },

        // "manual" audits. Just verify in the results.
        'pwa-cross-browser': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-page-transitions': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-each-page-has-url': {
          score: null,
          scoreDisplayMode: 'manual',
        },
      },
    },
  },

  {
    lhr: {
      requestedUrl: 'https://caltrainschedule.io/',
      finalUrl: 'https://caltrainschedule.io/',
      audits: {
        'redirects-http': {
          score: 1,
        },
        'service-worker': {
          score: 1,
        },
        'viewport': {
          score: 1,
        },
        'installable-manifest': {
          score: 1,
          details: {items: [], debugData: {manifestUrl: 'https://caltrainschedule.io/manifest.json'}},
        },
        'splash-screen': {
          score: 1,
          details: {items: [pwaDetailsExpectations]},
        },
        'themed-omnibox': {
          score: 0,
        },
        'content-width': {
          score: 1,
        },
        'apple-touch-icon': {
          score: 1,
        },

        // "manual" audits. Just verify in the results.
        'pwa-cross-browser': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-page-transitions': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-each-page-has-url': {
          score: null,
          scoreDisplayMode: 'manual',
        },
      },
    },
  },
];

},{"./pwa-expectations-details.js":30}],33:[function(require,module,exports){
/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const pwaDetailsExpectations = require('./pwa-expectations-details.js');
const pwaRocksExpectations = {...pwaDetailsExpectations, hasIconsAtLeast512px: false};

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for various sites with stable(ish) PWA
 * results.
 */
module.exports = [
  {
    lhr: {
      // Archived version of https://github.com/pwarocks/pwa.rocks
      // Fork is here: https://github.com/connorjclark/pwa.rocks
      requestedUrl: 'https://connorjclark.github.io/pwa.rocks/',
      finalUrl: 'https://connorjclark.github.io/pwa.rocks/',
      audits: {
        'redirects-http': {
          score: 1,
        },
        'service-worker': {
          score: 1,
        },
        'viewport': {
          score: 1,
        },
        'installable-manifest': {
          score: 1,
          details: {items: [], debugData: {manifestUrl: 'https://connorjclark.github.io/pwa.rocks/pwa.webmanifest'}},
        },
        'splash-screen': {
          score: 0,
          details: {items: [pwaRocksExpectations]},
        },
        'themed-omnibox': {
          score: 0,
          details: {items: [pwaRocksExpectations]},
        },
        'content-width': {
          score: 1,
        },
        'apple-touch-icon': {
          score: 1,
        },

        // "manual" audits. Just verify in the results.
        'pwa-cross-browser': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-page-transitions': {
          score: null,
          scoreDisplayMode: 'manual',
        },
        'pwa-each-page-has-url': {
          score: null,
          scoreDisplayMode: 'manual',
        },
      },
    },
  },
];

},{"./pwa-expectations-details.js":30}],34:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for redirects tests
 */
const expectations = [
  {
    // Single server-side redirect (2s)
    lhr: {
      requestedUrl: `http://localhost:10200/online-only.html?delay=2000&redirect=%2Fredirects-final.html`,
      finalUrl: 'http://localhost:10200/redirects-final.html',
      audits: {
        'first-contentful-paint': {
          numericValue: '>=2000',
        },
        'interactive': {
          numericValue: '>=2000',
        },
        'speed-index': {
          numericValue: '>=2000',
        },
        'redirects': {
          score: 1,
          numericValue: '>=2000',
          details: {
            items: {
              length: 2,
            },
          },
        },
      },
      runWarnings: [
        /The page may not be loading as expected because your test URL \(.*online-only.html.*\) was redirected to .*redirects-final.html. Try testing the second URL directly./,
      ],
    },
  },
  {
    // Multiple server-side redirects (3 x 1s)
    lhr: {
      requestedUrl: `http://localhost:10200/online-only.html?delay=1000&redirect_count=3&redirect=%2Fredirects-final.html`,
      finalUrl: 'http://localhost:10200/redirects-final.html',
      audits: {
        'first-contentful-paint': {
          numericValue: '>=3000',
        },
        'interactive': {
          numericValue: '>=3000',
        },
        'speed-index': {
          numericValue: '>=3000',
        },
        'redirects': {
          score: '<1',
          details: {
            items: {
              length: 4,
            },
          },
        },
      },
      runWarnings: [
        /The page may not be loading as expected because your test URL \(.*online-only.html.*\) was redirected to .*redirects-final.html. Try testing the second URL directly./,
      ],
    },
  },
  {
    // Client-side redirect (2s + 5s), paints at 2s, server-side redirect (1s)
    // TODO: Assert performance metrics on client-side redirects, see https://github.com/GoogleChrome/lighthouse/pull/10325
    lhr: {
      requestedUrl: `http://localhost:10200/js-redirect.html?delay=2000&jsDelay=5000&jsRedirect=%2Fonline-only.html%3Fdelay%3D1000%26redirect%3D%2Fredirects-final.html`,
      finalUrl: 'http://localhost:10200/redirects-final.html',
      audits: {
        // Just captures the server-side at the moment, should be 8s in the future
        'first-contentful-paint': {
          numericValue: '>=1000',
        },
        'interactive': {
          numericValue: '>=1000',
        },
        'speed-index': {
          numericValue: '>=1000',
        },
        'redirects': {
          score: '<1',
          numericValue: '>=8000',
          details: {
            items: {
              length: 3,
            },
          },
        },
      },
      runWarnings: [
        /The page may not be loading as expected because your test URL \(.*js-redirect.html.*\) was redirected to .*redirects-final.html. Try testing the second URL directly./,
      ],
    },
  },
  {
    // Client-side redirect (2s + 5s), no paint
    // TODO: Assert performance metrics on client-side redirects, see https://github.com/GoogleChrome/lighthouse/pull/10325
    lhr: {
      requestedUrl: `http://localhost:10200/js-redirect.html?delay=2000&jsDelay=5000&jsRedirect=%2Fredirects-final.html`,
      finalUrl: 'http://localhost:10200/redirects-final.html',
      audits: {
      },
      runWarnings: [
        /The page may not be loading as expected because your test URL \(.*js-redirect.html.*\) was redirected to .*redirects-final.html. Try testing the second URL directly./,
      ],
    },
  },
  {
    // Client-side redirect (2s + 5s), paints at 2s, server-side redirect (1s)
    // TODO: Assert performance metrics on client-side redirects, see https://github.com/GoogleChrome/lighthouse/pull/10325
    lhr: {
      requestedUrl: `http://localhost:10200/js-redirect.html?delay=2000&jsDelay=5000&jsRedirect=%2Fonline-only.html%3Fdelay%3D1000%26redirect%3D%2Fredirects-final.html%253FpushState`,
      // Note that the final URL is the URL of the network requested resource and not that page we end up on.
      // http://localhost:10200/push-state
      finalUrl: 'http://localhost:10200/redirects-final.html?pushState',
      audits: {
      },
      runWarnings: [
        /The page may not be loading as expected because your test URL \(.*js-redirect.html.*\) was redirected to .*redirects-final.html\?pushState. Try testing the second URL directly./,
      ],
    },
  },
];

module.exports = expectations;

},{}],35:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running PWA smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: [
      'first-contentful-paint',
      'interactive',
      'speed-index',
      'redirects',
    ],
    // Use provided throttling method to test usage of correct navStart.
    throttlingMethod: /** @type {'provided'} */ ('provided'),
  },
};

},{}],36:[function(require,module,exports){
/**
 * @license Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 */
const expectations = [
  {
    artifacts: {
      FullPageScreenshot: {
        screenshot: {
          width: '>1000',
          height: '>1000',
          data: /data:image\/jpeg;base64,.{10000,}$/,
        },
        nodes: {
          'page-0-BODY': {
            top: 8,
            bottom: 1008,
            left: 8,
            right: 1008,
            width: 1000,
            height: 1000,
          },
          // The following 2 are the same element (from different JS contexts). This element
          // starts with height ~18 and grows over time. See screenshot.html.
          'page-1-P': {
            top: 8,
            left: 8,
            height: '>40',
          },
          // Note: The first number (5) in these ids comes from an executionContextId, and has the potential to change
          '5-1-P': {
            top: 8,
            left: 8,
            height: '>40',
          },
          '5-2-BODY': {
            top: 8,
            bottom: 1008,
            left: 8,
            right: 1008,
            width: 1000,
            height: 1000,
          },
          '5-3-HTML': {},
        },
      },
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/screenshot.html?width=1000px&height=1000px',
      finalUrl: 'http://localhost:10200/screenshot.html?width=1000px&height=1000px',
      audits: {},
    },
  },
];

module.exports = expectations;

},{}],37:[function(require,module,exports){
/**
 * @license Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @type {LH.Config.Json} */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'desktop',
    screenEmulation: {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
      disabled: false,
    },
  },
};

},{}],38:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const BASE_URL = 'http://localhost:10200/seo/';

/**
 * @param {[string, string][]} headers
 * @return {string}
 */
function headersParam(headers) {
  const headerString = new URLSearchParams(headers).toString();
  return new URLSearchParams([['extra_header', headerString]]).toString();
}

const expectedGatheredTapTargets = [
  {
    node: {
      snippet: /large-link-at-bottom-of-page/,
    },
  },
  {
    node: {
      snippet: /visible-target/,
    },
  },
  {
    node: {
      snippet: /target-with-client-rect-outside-scroll-container/,
    },
  },
  {
    node: {
      snippet: /link-containing-large-inline-block-element/,
    },
  },
  {
    node: {
      snippet: /link-next-to-link-containing-large-inline-block-element/,
    },
  },
  {
    node: {
      snippet: /tap-target-containing-other-tap-targets/,
    },
  },
  {
    node: {
      snippet: /child-client-rect-hidden-by-overflow-hidden/,
    },
  },
  {
    node: {
      snippet: /tap-target-next-to-child-client-rect-hidden-by-overflow-hidden/,
    },
  },
  {
    node: {
      snippet: /child-client-rect-overlapping-other-target/,
    },
    shouldFail: true,
  },
  {
    node: {
      snippet: /tap-target-overlapped-by-other-targets-position-absolute-child-rect/,
    },
    shouldFail: true,
  },
  {
    node: {
      snippet: /position-absolute-tap-target-fully-contained-in-other-target/,
    },
  },
  {
    node: {
      snippet: /tap-target-fully-containing-position-absolute-target/,
    },
  },
  {
    node: {
      snippet: /too-small-failing-tap-target/,
    },
    shouldFail: true,
  },
  {
    node: {
      snippet: /large-enough-tap-target-next-to-too-small-tap-target/,
    },
  },
  {
    node: {
      snippet: /zero-width-tap-target-with-overflowing-child-content/,
    },
    shouldFail: true,
  },
  {
    node: {
      snippet: /passing-tap-target-next-to-zero-width-target/,
    },
  },
  {
    node: {
      snippet: /links-with-same-link-target-1/,
    },
  },
  {
    node: {
      snippet: /links-with-same-link-target-2/,
    },
  },
];

const failureHeaders = headersParam([[
  'x-robots-tag',
  'none',
], [
  'link',
  '<http://example.com>;rel="alternate";hreflang="xx"',
], [
  'link',
  '<https://example.com>; rel="canonical"',
]]);

const passHeaders = headersParam([[
  'link',
  '<http://localhost:10200/seo/>; rel="canonical"',
]]);

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for seo tests
 */
const expectations = [
  {
    lhr: {
      requestedUrl: BASE_URL + 'seo-tester.html?' + passHeaders,
      finalUrl: BASE_URL + 'seo-tester.html?' + passHeaders,
      audits: {
        'viewport': {
          score: 1,
        },
        'document-title': {
          score: 1,
        },
        'meta-description': {
          score: 1,
        },
        'http-status-code': {
          score: 1,
        },
        'font-size': {
          score: 1,
          details: {
            items: [
              {
                source: {
                  url: /seo-tester\.html.+$/,
                  urlProvider: 'network',
                  line: 23,
                  column: 12,
                },
                selector: '.small',
                fontSize: '11px',
              },
              {
                source: {
                  url: /seo-tester\.html.+$/,
                  urlProvider: 'network',
                  line: 27,
                  column: 55,
                },
                selector: '.small-2',
                fontSize: '11px',
              },
              {
                source: {
                  url: /seo-tester-inline-magic\.css$/,
                  urlProvider: 'comment',
                  line: 2,
                  column: 14,
                },
                selector: '.small-3',
                fontSize: '6px',
              },
              {
                source: {
                  url: /seo-tester-styles-magic\.css$/,
                  urlProvider: 'comment',
                  line: 2,
                  column: 10,
                },
                selector: '.small-4',
                fontSize: '6px',
              },
              {
                source: {type: 'code', value: 'User Agent Stylesheet'},
                selector: 'h6',
                fontSize: '10.72px',
              },
              {
                source: {type: 'url', value: /seo-tester\.html.+$/},
                selector: {
                  type: 'node',
                  selector: 'body',
                  snippet: '<font size="1">',
                },
                fontSize: '10px',
              },
              {
                source: {type: 'url', value: /seo-tester\.html.+$/},
                selector: {
                  type: 'node',
                  selector: 'font',
                  snippet: '<b>',
                },
                fontSize: '10px',
              },
              {
                source: {type: 'url', value: /seo-tester\.html.+$/},
                selector: {
                  type: 'node',
                  selector: 'div',
                  snippet: '<p style="font-size:10px">',
                },
                fontSize: '10px',
              },
              {
                source: {type: 'code', value: 'Legible text'},
                selector: '',
                fontSize: '≥ 12px',
              },
            ],
          },
        },
        'crawlable-anchors': {
          score: 1,
        },
        'link-text': {
          score: 1,
        },
        'is-crawlable': {
          score: 1,
        },
        'hreflang': {
          score: 1,
        },
        'plugins': {
          score: 1,
        },
        'canonical': {
          score: 1,
        },
        'robots-txt': {
          score: null,
          scoreDisplayMode: 'notApplicable',
        },
      },
    }},
  {
    lhr: {
      requestedUrl: BASE_URL + 'seo-failure-cases.html?' + failureHeaders,
      finalUrl: BASE_URL + 'seo-failure-cases.html?' + failureHeaders,
      audits: {
        'viewport': {
          score: 0,
        },
        'document-title': {
          score: 0,
        },
        'meta-description': {
          score: 0,
        },
        'http-status-code': {
          score: 1,
        },
        'font-size': {
          score: 0,
          explanation:
          'Text is illegible because there\'s no viewport meta tag optimized for mobile screens.',
        },
        'crawlable-anchors': {
          score: 0,
          details: {
            items: {
              length: 4,
            },
          },
        },
        'link-text': {
          score: 0,
          displayValue: '4 links found',
          details: {
            items: {
              length: 4,
            },
          },
        },
        'is-crawlable': {
          score: 0,
          details: {
            items: {
              length: 2,
            },
          },
        },
        'hreflang': {
          score: 0,
          details: {
            items: {
              length: 5,
            },
          },
        },
        'plugins': {
          score: 0,
          details: {
            items: {
              length: 3,
            },
          },
        },
        'canonical': {
          score: 0,
          explanation: 'Multiple conflicting URLs (https://example.com/other, https://example.com/)',
        },
      },
    },
  },
  {
    lhr: {
      // Note: most scores are null (audit error) because the page 403ed.
      requestedUrl: BASE_URL + 'seo-failure-cases.html?status_code=403',
      finalUrl: BASE_URL + 'seo-failure-cases.html?status_code=403',
      runtimeError: {
        code: 'ERRORED_DOCUMENT_REQUEST',
        message: /Status code: 403/,
      },
      runWarnings: ['Lighthouse was unable to reliably load the page you requested. Make sure you are testing the correct URL and that the server is properly responding to all requests. (Status code: 403)'],
      audits: {
        'http-status-code': {
          score: null,
        },
        'viewport': {
          score: null,
        },
        'document-title': {
          score: null,
        },
        'meta-description': {
          score: null,
        },
        'font-size': {
          score: null,
        },
        'crawlable-anchors': {
          score: null,
        },
        'link-text': {
          score: null,
        },
        'is-crawlable': {
          score: null,
        },
        'hreflang': {
          score: null,
        },
        'plugins': {
          score: null,
        },
        'canonical': {
          score: null,
        },
      },
    }},
  {
    lhr: {
      finalUrl: BASE_URL + 'seo-tap-targets.html',
      requestedUrl: BASE_URL + 'seo-tap-targets.html',
      audits: {
        'tap-targets': {
          score: (() => {
            const totalTapTargets = expectedGatheredTapTargets.length;
            const passingTapTargets = expectedGatheredTapTargets.filter(t => !t.shouldFail).length;
            const SCORE_FACTOR = 0.89;
            return Math.round(passingTapTargets / totalTapTargets * SCORE_FACTOR * 100) / 100;
          })(),
          details: {
            items: [
              {
                'tapTarget': {
                  'type': 'node',
                  /* eslint-disable max-len */
                  'snippet': '<a data-gathered-target="zero-width-tap-target-with-overflowing-child-content" style="display: block; width: 0; white-space: nowrap">',
                  'path': '2,HTML,1,BODY,14,DIV,0,A',
                  'selector': 'body > div > a',
                  'nodeLabel': 'zero width target',
                },
                'overlappingTarget': {
                  'type': 'node',
                  /* eslint-disable max-len */
                  'snippet': '<a data-gathered-target="passing-tap-target-next-to-zero-width-target" style="display: block; width: 110px; height: 100px;background: #aaa;">',
                  'path': '2,HTML,1,BODY,14,DIV,1,A',
                  'selector': 'body > div > a',
                  'nodeLabel': 'passing target',
                },
                'tapTargetScore': 864,
                'overlappingTargetScore': 720,
                'overlapScoreRatio': 0.8333333333333334,
                'size': '110x18',
                'width': 110,
                'height': 18,
              },
              {
                'tapTarget': {
                  'type': 'node',
                  'path': '2,HTML,1,BODY,10,DIV,0,DIV,1,A',
                  'selector': 'body > div > div > a',
                  'nodeLabel': 'too small target',
                },
                'overlappingTarget': {
                  'type': 'node',
                  'path': '2,HTML,1,BODY,10,DIV,0,DIV,2,A',
                  'selector': 'body > div > div > a',
                  'nodeLabel': 'big enough target',
                },
                'tapTargetScore': 1440,
                'overlappingTargetScore': 432,
                'overlapScoreRatio': 0.3,
                'size': '100x30',
                'width': 100,
                'height': 30,
              },
              {
                'tapTarget': {
                  'type': 'node',
                  'path': '2,HTML,1,BODY,3,DIV,24,A',
                  'selector': 'body > div > a',
                  'nodeLabel': 'left',
                },
                'overlappingTarget': {
                  'type': 'node',
                  'path': '2,HTML,1,BODY,3,DIV,25,A',
                  'selector': 'body > div > a',
                  'nodeLabel': 'right',
                },
                'tapTargetScore': 1920,
                'overlappingTargetScore': 560,
                'overlapScoreRatio': 0.2916666666666667,
                'size': '40x40',
                'width': 40,
                'height': 40,
              },
            ],
          },
        },
      },
    },
    artifacts: {
      TapTargets: expectedGatheredTapTargets.map(({node}) => ({node})),
    },
  },
];

module.exports = expectations;

},{}],39:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running SEO smokehouse audits.
 */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['seo'],
  },
};

},{}],40:[function(require,module,exports){
/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';



const mapJson =
  "{\n  \"version\": 3,\n  \"file\": \"out.js\",\n  \"sourceRoot\": \"\",\n  \"sources\": [\"foo.js\", \"bar.js\"],\n  \"names\": [\"src\", \"maps\", \"are\", \"fun\"],\n  \"mappings\": \"AAgBC,SAAQ,CAAEA\"\n}\n";
const map = JSON.parse(mapJson);

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for seo tests
 *
 * We have experienced timeouts in the past when fetching source maps.
 * We should verify the timing issue in Chromium if this gets flaky.
 */
const expectations = [
  {
    artifacts: {
      SourceMaps: [
        {
          scriptUrl: 'http://localhost:10200/source-map/source-map-tester.html',
          sourceMapUrl: 'http://localhost:10200/source-map/script.js.map',
          map,
        },
        {
          scriptUrl: 'http://localhost:10200/source-map/source-map-tester.html',
          sourceMapUrl: 'http://localhost:10503/source-map/script.js.map',
          map,
        },
      ],
    },
    lhr: {
      requestedUrl: 'http://localhost:10200/source-map/source-map-tester.html',
      finalUrl: 'http://localhost:10200/source-map/source-map-tester.html',
      audits: {},
    },
  },
];

module.exports = expectations;

},{}],41:[function(require,module,exports){
/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * Config file for running source map smokehouse.
 */

/** @type {LH.Config.Json} */
module.exports = {
  extends: 'lighthouse:default',
  settings: {
    onlyAudits: ['unused-javascript'],
  },
};

},{}],42:[function(require,module,exports){
/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @type {Array<Smokehouse.ExpectedRunnerResult>}
 * Expected Lighthouse audit values for tricky metrics tests that previously failed to be computed.
 * We only place lower bounds because we are checking that these metrics *can* be computed and that
 * we wait long enough to compute them. Upper bounds aren't very helpful here and tend to cause flaky failures.
 */
module.exports = [
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/tricky-tti.html',
      finalUrl: 'http://localhost:10200/tricky-tti.html',
      audits: {
        'interactive': {
          // stalls for ~5 seconds, ~5 seconds out, so should be at least ~10s
          numericValue: '>9900',
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/tricky-tti-late-fcp.html',
      finalUrl: 'http://localhost:10200/tricky-tti-late-fcp.html',
      audits: {
        'interactive': {
          // FCP at least ~5 seconds out
          numericValue: '>4900',
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/delayed-lcp.html',
      finalUrl: 'http://localhost:10200/delayed-lcp.html',
      audits: {
        'largest-contentful-paint': {
          // LCP is after the ~7s XHR and the ~7s image.
          numericValue: '>14000',
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/delayed-fcp.html',
      finalUrl: 'http://localhost:10200/delayed-fcp.html',
      audits: {
        'first-contentful-paint': {
          numericValue: '>1', // We just want to check that it doesn't error
        },
      },
    },
  },
  {
    lhr: {
      requestedUrl: 'http://localhost:10200/debugger.html',
      finalUrl: 'http://localhost:10200/debugger.html',
      audits: {
        'first-contentful-paint': {
          numericValue: '>1', // We just want to check that it doesn't error
        },
      },
    },
  },
];

},{}],43:[function(require,module,exports){
/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * A config with no throttling used for tricky-metrics tests.
 * Those class of tricky metrics need to use observed metrics and DevTools throttling has too many bugs
 * to capture the nuances we're testing.
 */

/** @type {LH.Config.Json} */
const noThrottlingConfig = {
  extends: 'lighthouse:default',
  settings: {
    throttlingMethod: 'provided',
    onlyCategories: ['performance'],
  },
};

module.exports = noThrottlingConfig;

},{}],44:[function(require,module,exports){

},{}],45:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var R = typeof Reflect === 'object' ? Reflect : null
var ReflectApply = R && typeof R.apply === 'function'
  ? R.apply
  : function ReflectApply(target, receiver, args) {
    return Function.prototype.apply.call(target, receiver, args);
  }

var ReflectOwnKeys
if (R && typeof R.ownKeys === 'function') {
  ReflectOwnKeys = R.ownKeys
} else if (Object.getOwnPropertySymbols) {
  ReflectOwnKeys = function ReflectOwnKeys(target) {
    return Object.getOwnPropertyNames(target)
      .concat(Object.getOwnPropertySymbols(target));
  };
} else {
  ReflectOwnKeys = function ReflectOwnKeys(target) {
    return Object.getOwnPropertyNames(target);
  };
}

function ProcessEmitWarning(warning) {
  if (console && console.warn) console.warn(warning);
}

var NumberIsNaN = Number.isNaN || function NumberIsNaN(value) {
  return value !== value;
}

function EventEmitter() {
  EventEmitter.init.call(this);
}
module.exports = EventEmitter;
module.exports.once = once;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

function checkListener(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
  }
}

Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  enumerable: true,
  get: function() {
    return defaultMaxListeners;
  },
  set: function(arg) {
    if (typeof arg !== 'number' || arg < 0 || NumberIsNaN(arg)) {
      throw new RangeError('The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ' + arg + '.');
    }
    defaultMaxListeners = arg;
  }
});

EventEmitter.init = function() {

  if (this._events === undefined ||
      this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
};

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || NumberIsNaN(n)) {
    throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + n + '.');
  }
  this._maxListeners = n;
  return this;
};

function _getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return _getMaxListeners(this);
};

EventEmitter.prototype.emit = function emit(type) {
  var args = [];
  for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
  var doError = (type === 'error');

  var events = this._events;
  if (events !== undefined)
    doError = (doError && events.error === undefined);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    var er;
    if (args.length > 0)
      er = args[0];
    if (er instanceof Error) {
      // Note: The comments on the `throw` lines are intentional, they show
      // up in Node's output if this results in an unhandled exception.
      throw er; // Unhandled 'error' event
    }
    // At least give some kind of context to the user
    var err = new Error('Unhandled error.' + (er ? ' (' + er.message + ')' : ''));
    err.context = er;
    throw err; // Unhandled 'error' event
  }

  var handler = events[type];

  if (handler === undefined)
    return false;

  if (typeof handler === 'function') {
    ReflectApply(handler, this, args);
  } else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      ReflectApply(listeners[i], this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  checkListener(listener);

  events = target._events;
  if (events === undefined) {
    events = target._events = Object.create(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener !== undefined) {
      target.emit('newListener', type,
                  listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (existing === undefined) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
        prepend ? [listener, existing] : [existing, listener];
      // If we've already got an array, just append.
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }

    // Check for listener leak
    m = _getMaxListeners(target);
    if (m > 0 && existing.length > m && !existing.warned) {
      existing.warned = true;
      // No error code for this since it is a Warning
      // eslint-disable-next-line no-restricted-syntax
      var w = new Error('Possible EventEmitter memory leak detected. ' +
                          existing.length + ' ' + String(type) + ' listeners ' +
                          'added. Use emitter.setMaxListeners() to ' +
                          'increase limit');
      w.name = 'MaxListenersExceededWarning';
      w.emitter = target;
      w.type = type;
      w.count = existing.length;
      ProcessEmitWarning(w);
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    if (arguments.length === 0)
      return this.listener.call(this.target);
    return this.listener.apply(this.target, arguments);
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = onceWrapper.bind(state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  checkListener(listener);
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      checkListener(listener);
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      checkListener(listener);

      events = this._events;
      if (events === undefined)
        return this;

      list = events[type];
      if (list === undefined)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = Object.create(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else {
          spliceOne(list, position);
        }

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener !== undefined)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (events === undefined)
        return this;

      // not listening for removeListener, no need to emit
      if (events.removeListener === undefined) {
        if (arguments.length === 0) {
          this._events = Object.create(null);
          this._eventsCount = 0;
        } else if (events[type] !== undefined) {
          if (--this._eventsCount === 0)
            this._events = Object.create(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = Object.keys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = Object.create(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners !== undefined) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  var events = target._events;

  if (events === undefined)
    return [];

  var evlistener = events[type];
  if (evlistener === undefined)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ?
    unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events !== undefined) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener !== undefined) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
};

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function spliceOne(list, index) {
  for (; index + 1 < list.length; index++)
    list[index] = list[index + 1];
  list.pop();
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function once(emitter, name) {
  return new Promise(function (resolve, reject) {
    function errorListener(err) {
      emitter.removeListener(name, resolver);
      reject(err);
    }

    function resolver() {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener('error', errorListener);
      }
      resolve([].slice.call(arguments));
    };

    eventTargetAgnosticAddListener(emitter, name, resolver, { once: true });
    if (name !== 'error') {
      addErrorHandlerIfEventEmitter(emitter, errorListener, { once: true });
    }
  });
}

function addErrorHandlerIfEventEmitter(emitter, handler, flags) {
  if (typeof emitter.on === 'function') {
    eventTargetAgnosticAddListener(emitter, 'error', handler, flags);
  }
}

function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
  if (typeof emitter.on === 'function') {
    if (flags.once) {
      emitter.once(name, listener);
    } else {
      emitter.on(name, listener);
    }
  } else if (typeof emitter.addEventListener === 'function') {
    // EventTarget does not have `error` event semantics like Node
    // EventEmitters, we do not listen for `error` events here.
    emitter.addEventListener(name, function wrapListener(arg) {
      // IE does not have builtin `{ once: true }` support so we
      // have to do it manually.
      if (flags.once) {
        emitter.removeEventListener(name, wrapListener);
      }
      listener(arg);
    });
  } else {
    throw new TypeError('The "emitter" argument must be of type EventEmitter. Received type ' + typeof emitter);
  }
}

},{}],46:[function(require,module,exports){
(function (process){(function (){
/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const debug = require('debug');
const marky = require('marky');

const EventEmitter = require('events').EventEmitter;
const isWindows = process.platform === 'win32';

// process.browser is set when browserify'd via the `process` npm module
const isBrowser = process.browser;

const colors = {
  red: isBrowser ? 'crimson' : 1,
  yellow: isBrowser ? 'gold' : 3,
  cyan: isBrowser ? 'darkturquoise' : 6,
  green: isBrowser ? 'forestgreen' : 2,
  blue: isBrowser ? 'steelblue' : 4,
  magenta: isBrowser ? 'palevioletred' : 5,
};

// whitelist non-red/yellow colors for debug()
debug.colors = [colors.cyan, colors.green, colors.blue, colors.magenta];

class Emitter extends EventEmitter {
  /**
   * Fires off all status updates. Listen with
   * `require('lib/log').events.addListener('status', callback)`
   * @param {string} title
   * @param {!Array<*>} argsArray
   */
  issueStatus(title, argsArray) {
    if (title === 'status' || title === 'statusEnd') {
      this.emit(title, [title, ...argsArray]);
    }
  }

  /**
   * Fires off all warnings. Listen with
   * `require('lib/log').events.addListener('warning', callback)`
   * @param {string} title
   * @param {!Array<*>} argsArray
   */
  issueWarning(title, argsArray) {
    this.emit('warning', [title, ...argsArray]);
  }
}

const loggersByTitle = {};
const loggingBufferColumns = 25;
let level_;

class Log {
  static _logToStdErr(title, argsArray) {
    const log = Log.loggerfn(title);
    log(...argsArray);
  }

  static loggerfn(title) {
    let log = loggersByTitle[title];
    if (!log) {
      log = debug(title);
      loggersByTitle[title] = log;
      // errors with red, warnings with yellow.
      if (title.endsWith('error')) {
        log.color = colors.red;
      } else if (title.endsWith('warn')) {
        log.color = colors.yellow;
      }
    }
    return log;
  }

  /**
   * @param {string} level
   */
  static setLevel(level) {
    level_ = level;
    switch (level) {
      case 'silent':
        debug.enable('-*');
        break;
      case 'verbose':
        debug.enable('*');
        break;
      case 'error':
        debug.enable('-*, *:error');
        break;
      default:
        debug.enable('*, -*:verbose');
    }
  }

  /**
   * A simple formatting utility for event logging.
   * @param {string} prefix
   * @param {!Object} data A JSON-serializable object of event data to log.
   * @param {string=} level Optional logging level. Defaults to 'log'.
   */
  static formatProtocol(prefix, data, level) {
    const columns = (!process || process.browser) ? Infinity : process.stdout.columns;
    const method = data.method || '?????';
    const maxLength = columns - method.length - prefix.length - loggingBufferColumns;
    // IO.read blacklisted here to avoid logging megabytes of trace data
    const snippet = (data.params && method !== 'IO.read') ?
      JSON.stringify(data.params).substr(0, maxLength) : '';
    Log._logToStdErr(`${prefix}:${level || ''}`, [method, snippet]);
  }

  /**
   * @return {boolean}
   */
  static isVerbose() {
    return level_ === 'verbose';
  }

  static time({msg, id, args = []}, level = 'log') {
    marky.mark(id);
    Log[level]('status', msg, ...args);
  }

  static timeEnd({msg, id, args = []}, level = 'verbose') {
    Log[level]('statusEnd', msg, ...args);
    marky.stop(id);
  }

  static log(title, ...args) {
    Log.events.issueStatus(title, args);
    return Log._logToStdErr(title, args);
  }

  static warn(title, ...args) {
    Log.events.issueWarning(title, args);
    return Log._logToStdErr(`${title}:warn`, args);
  }

  static error(title, ...args) {
    return Log._logToStdErr(`${title}:error`, args);
  }

  static verbose(title, ...args) {
    Log.events.issueStatus(title, args);
    return Log._logToStdErr(`${title}:verbose`, args);
  }

  /**
   * Add surrounding escape sequences to turn a string green when logged.
   * @param {string} str
   * @return {string}
   */
  static greenify(str) {
    return `${Log.green}${str}${Log.reset}`;
  }

  /**
   * Add surrounding escape sequences to turn a string red when logged.
   * @param {string} str
   * @return {string}
   */
  static redify(str) {
    return `${Log.red}${str}${Log.reset}`;
  }

  static get green() {
    return '\x1B[32m';
  }

  static get red() {
    return '\x1B[31m';
  }

  static get yellow() {
    return '\x1b[33m';
  }

  static get purple() {
    return '\x1b[95m';
  }

  static get reset() {
    return '\x1B[0m';
  }

  static get bold() {
    return '\x1b[1m';
  }

  static get dim() {
    return '\x1b[2m';
  }

  static get tick() {
    return isWindows ? '\u221A' : '✓';
  }

  static get cross() {
    return isWindows ? '\u00D7' : '✘';
  }

  static get whiteSmallSquare() {
    return isWindows ? '\u0387' : '▫';
  }

  static get heavyHorizontal() {
    return isWindows ? '\u2500' : '━';
  }

  static get heavyVertical() {
    return isWindows ? '\u2502 ' : '┃ ';
  }

  static get heavyUpAndRight() {
    return isWindows ? '\u2514' : '┗';
  }

  static get heavyVerticalAndRight() {
    return isWindows ? '\u251C' : '┣';
  }

  static get heavyDownAndHorizontal() {
    return isWindows ? '\u252C' : '┳';
  }

  static get doubleLightHorizontal() {
    return '──';
  }
}

Log.events = new Emitter();
Log.takeTimeEntries = () => {
  const entries = marky.getEntries();
  marky.clear();
  return entries;
};
Log.getTimeEntries = () => marky.getEntries();

module.exports = Log;

}).call(this)}).call(this,require('_process'))
},{"_process":52,"debug":47,"events":45,"marky":51}],47:[function(require,module,exports){
(function (process){(function (){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this)}).call(this,require('_process'))
},{"./debug":48,"_process":52}],48:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":49}],49:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],50:[function(require,module,exports){
(function (global){(function (){
/**
 * lodash (Custom Build) <https://lodash.com/>
 * Build: `lodash modularize exports="npm" -o ./`
 * Copyright jQuery Foundation and other contributors <https://jquery.org/>
 * Released under MIT license <https://lodash.com/license>
 * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
 * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
 */

/** Used as the size to enable large array optimizations. */
var LARGE_ARRAY_SIZE = 200;

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/** Used as references for various `Number` constants. */
var MAX_SAFE_INTEGER = 9007199254740991;

/** `Object#toString` result references. */
var argsTag = '[object Arguments]',
    arrayTag = '[object Array]',
    boolTag = '[object Boolean]',
    dateTag = '[object Date]',
    errorTag = '[object Error]',
    funcTag = '[object Function]',
    genTag = '[object GeneratorFunction]',
    mapTag = '[object Map]',
    numberTag = '[object Number]',
    objectTag = '[object Object]',
    promiseTag = '[object Promise]',
    regexpTag = '[object RegExp]',
    setTag = '[object Set]',
    stringTag = '[object String]',
    symbolTag = '[object Symbol]',
    weakMapTag = '[object WeakMap]';

var arrayBufferTag = '[object ArrayBuffer]',
    dataViewTag = '[object DataView]',
    float32Tag = '[object Float32Array]',
    float64Tag = '[object Float64Array]',
    int8Tag = '[object Int8Array]',
    int16Tag = '[object Int16Array]',
    int32Tag = '[object Int32Array]',
    uint8Tag = '[object Uint8Array]',
    uint8ClampedTag = '[object Uint8ClampedArray]',
    uint16Tag = '[object Uint16Array]',
    uint32Tag = '[object Uint32Array]';

/**
 * Used to match `RegExp`
 * [syntax characters](http://ecma-international.org/ecma-262/7.0/#sec-patterns).
 */
var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;

/** Used to match `RegExp` flags from their coerced string values. */
var reFlags = /\w*$/;

/** Used to detect host constructors (Safari). */
var reIsHostCtor = /^\[object .+?Constructor\]$/;

/** Used to detect unsigned integer values. */
var reIsUint = /^(?:0|[1-9]\d*)$/;

/** Used to identify `toStringTag` values supported by `_.clone`. */
var cloneableTags = {};
cloneableTags[argsTag] = cloneableTags[arrayTag] =
cloneableTags[arrayBufferTag] = cloneableTags[dataViewTag] =
cloneableTags[boolTag] = cloneableTags[dateTag] =
cloneableTags[float32Tag] = cloneableTags[float64Tag] =
cloneableTags[int8Tag] = cloneableTags[int16Tag] =
cloneableTags[int32Tag] = cloneableTags[mapTag] =
cloneableTags[numberTag] = cloneableTags[objectTag] =
cloneableTags[regexpTag] = cloneableTags[setTag] =
cloneableTags[stringTag] = cloneableTags[symbolTag] =
cloneableTags[uint8Tag] = cloneableTags[uint8ClampedTag] =
cloneableTags[uint16Tag] = cloneableTags[uint32Tag] = true;
cloneableTags[errorTag] = cloneableTags[funcTag] =
cloneableTags[weakMapTag] = false;

/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = freeGlobal || freeSelf || Function('return this')();

/** Detect free variable `exports`. */
var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;

/** Detect free variable `module`. */
var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;

/** Detect the popular CommonJS extension `module.exports`. */
var moduleExports = freeModule && freeModule.exports === freeExports;

/**
 * Adds the key-value `pair` to `map`.
 *
 * @private
 * @param {Object} map The map to modify.
 * @param {Array} pair The key-value pair to add.
 * @returns {Object} Returns `map`.
 */
function addMapEntry(map, pair) {
  // Don't return `map.set` because it's not chainable in IE 11.
  map.set(pair[0], pair[1]);
  return map;
}

/**
 * Adds `value` to `set`.
 *
 * @private
 * @param {Object} set The set to modify.
 * @param {*} value The value to add.
 * @returns {Object} Returns `set`.
 */
function addSetEntry(set, value) {
  // Don't return `set.add` because it's not chainable in IE 11.
  set.add(value);
  return set;
}

/**
 * A specialized version of `_.forEach` for arrays without support for
 * iteratee shorthands.
 *
 * @private
 * @param {Array} [array] The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns `array`.
 */
function arrayEach(array, iteratee) {
  var index = -1,
      length = array ? array.length : 0;

  while (++index < length) {
    if (iteratee(array[index], index, array) === false) {
      break;
    }
  }
  return array;
}

/**
 * Appends the elements of `values` to `array`.
 *
 * @private
 * @param {Array} array The array to modify.
 * @param {Array} values The values to append.
 * @returns {Array} Returns `array`.
 */
function arrayPush(array, values) {
  var index = -1,
      length = values.length,
      offset = array.length;

  while (++index < length) {
    array[offset + index] = values[index];
  }
  return array;
}

/**
 * A specialized version of `_.reduce` for arrays without support for
 * iteratee shorthands.
 *
 * @private
 * @param {Array} [array] The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @param {*} [accumulator] The initial value.
 * @param {boolean} [initAccum] Specify using the first element of `array` as
 *  the initial value.
 * @returns {*} Returns the accumulated value.
 */
function arrayReduce(array, iteratee, accumulator, initAccum) {
  var index = -1,
      length = array ? array.length : 0;

  if (initAccum && length) {
    accumulator = array[++index];
  }
  while (++index < length) {
    accumulator = iteratee(accumulator, array[index], index, array);
  }
  return accumulator;
}

/**
 * The base implementation of `_.times` without support for iteratee shorthands
 * or max array length checks.
 *
 * @private
 * @param {number} n The number of times to invoke `iteratee`.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns the array of results.
 */
function baseTimes(n, iteratee) {
  var index = -1,
      result = Array(n);

  while (++index < n) {
    result[index] = iteratee(index);
  }
  return result;
}

/**
 * Gets the value at `key` of `object`.
 *
 * @private
 * @param {Object} [object] The object to query.
 * @param {string} key The key of the property to get.
 * @returns {*} Returns the property value.
 */
function getValue(object, key) {
  return object == null ? undefined : object[key];
}

/**
 * Checks if `value` is a host object in IE < 9.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a host object, else `false`.
 */
function isHostObject(value) {
  // Many host objects are `Object` objects that can coerce to strings
  // despite having improperly defined `toString` methods.
  var result = false;
  if (value != null && typeof value.toString != 'function') {
    try {
      result = !!(value + '');
    } catch (e) {}
  }
  return result;
}

/**
 * Converts `map` to its key-value pairs.
 *
 * @private
 * @param {Object} map The map to convert.
 * @returns {Array} Returns the key-value pairs.
 */
function mapToArray(map) {
  var index = -1,
      result = Array(map.size);

  map.forEach(function(value, key) {
    result[++index] = [key, value];
  });
  return result;
}

/**
 * Creates a unary function that invokes `func` with its argument transformed.
 *
 * @private
 * @param {Function} func The function to wrap.
 * @param {Function} transform The argument transform.
 * @returns {Function} Returns the new function.
 */
function overArg(func, transform) {
  return function(arg) {
    return func(transform(arg));
  };
}

/**
 * Converts `set` to an array of its values.
 *
 * @private
 * @param {Object} set The set to convert.
 * @returns {Array} Returns the values.
 */
function setToArray(set) {
  var index = -1,
      result = Array(set.size);

  set.forEach(function(value) {
    result[++index] = value;
  });
  return result;
}

/** Used for built-in method references. */
var arrayProto = Array.prototype,
    funcProto = Function.prototype,
    objectProto = Object.prototype;

/** Used to detect overreaching core-js shims. */
var coreJsData = root['__core-js_shared__'];

/** Used to detect methods masquerading as native. */
var maskSrcKey = (function() {
  var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || '');
  return uid ? ('Symbol(src)_1.' + uid) : '';
}());

/** Used to resolve the decompiled source of functions. */
var funcToString = funcProto.toString;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/** Used to detect if a method is native. */
var reIsNative = RegExp('^' +
  funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$'
);

/** Built-in value references. */
var Buffer = moduleExports ? root.Buffer : undefined,
    Symbol = root.Symbol,
    Uint8Array = root.Uint8Array,
    getPrototype = overArg(Object.getPrototypeOf, Object),
    objectCreate = Object.create,
    propertyIsEnumerable = objectProto.propertyIsEnumerable,
    splice = arrayProto.splice;

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeGetSymbols = Object.getOwnPropertySymbols,
    nativeIsBuffer = Buffer ? Buffer.isBuffer : undefined,
    nativeKeys = overArg(Object.keys, Object);

/* Built-in method references that are verified to be native. */
var DataView = getNative(root, 'DataView'),
    Map = getNative(root, 'Map'),
    Promise = getNative(root, 'Promise'),
    Set = getNative(root, 'Set'),
    WeakMap = getNative(root, 'WeakMap'),
    nativeCreate = getNative(Object, 'create');

/** Used to detect maps, sets, and weakmaps. */
var dataViewCtorString = toSource(DataView),
    mapCtorString = toSource(Map),
    promiseCtorString = toSource(Promise),
    setCtorString = toSource(Set),
    weakMapCtorString = toSource(WeakMap);

/** Used to convert symbols to primitives and strings. */
var symbolProto = Symbol ? Symbol.prototype : undefined,
    symbolValueOf = symbolProto ? symbolProto.valueOf : undefined;

/**
 * Creates a hash object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function Hash(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the hash.
 *
 * @private
 * @name clear
 * @memberOf Hash
 */
function hashClear() {
  this.__data__ = nativeCreate ? nativeCreate(null) : {};
}

/**
 * Removes `key` and its value from the hash.
 *
 * @private
 * @name delete
 * @memberOf Hash
 * @param {Object} hash The hash to modify.
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function hashDelete(key) {
  return this.has(key) && delete this.__data__[key];
}

/**
 * Gets the hash value for `key`.
 *
 * @private
 * @name get
 * @memberOf Hash
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function hashGet(key) {
  var data = this.__data__;
  if (nativeCreate) {
    var result = data[key];
    return result === HASH_UNDEFINED ? undefined : result;
  }
  return hasOwnProperty.call(data, key) ? data[key] : undefined;
}

/**
 * Checks if a hash value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf Hash
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function hashHas(key) {
  var data = this.__data__;
  return nativeCreate ? data[key] !== undefined : hasOwnProperty.call(data, key);
}

/**
 * Sets the hash `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf Hash
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the hash instance.
 */
function hashSet(key, value) {
  var data = this.__data__;
  data[key] = (nativeCreate && value === undefined) ? HASH_UNDEFINED : value;
  return this;
}

// Add methods to `Hash`.
Hash.prototype.clear = hashClear;
Hash.prototype['delete'] = hashDelete;
Hash.prototype.get = hashGet;
Hash.prototype.has = hashHas;
Hash.prototype.set = hashSet;

/**
 * Creates an list cache object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function ListCache(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the list cache.
 *
 * @private
 * @name clear
 * @memberOf ListCache
 */
function listCacheClear() {
  this.__data__ = [];
}

/**
 * Removes `key` and its value from the list cache.
 *
 * @private
 * @name delete
 * @memberOf ListCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function listCacheDelete(key) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  if (index < 0) {
    return false;
  }
  var lastIndex = data.length - 1;
  if (index == lastIndex) {
    data.pop();
  } else {
    splice.call(data, index, 1);
  }
  return true;
}

/**
 * Gets the list cache value for `key`.
 *
 * @private
 * @name get
 * @memberOf ListCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function listCacheGet(key) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  return index < 0 ? undefined : data[index][1];
}

/**
 * Checks if a list cache value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf ListCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function listCacheHas(key) {
  return assocIndexOf(this.__data__, key) > -1;
}

/**
 * Sets the list cache `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf ListCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the list cache instance.
 */
function listCacheSet(key, value) {
  var data = this.__data__,
      index = assocIndexOf(data, key);

  if (index < 0) {
    data.push([key, value]);
  } else {
    data[index][1] = value;
  }
  return this;
}

// Add methods to `ListCache`.
ListCache.prototype.clear = listCacheClear;
ListCache.prototype['delete'] = listCacheDelete;
ListCache.prototype.get = listCacheGet;
ListCache.prototype.has = listCacheHas;
ListCache.prototype.set = listCacheSet;

/**
 * Creates a map cache object to store key-value pairs.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function MapCache(entries) {
  var index = -1,
      length = entries ? entries.length : 0;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

/**
 * Removes all key-value entries from the map.
 *
 * @private
 * @name clear
 * @memberOf MapCache
 */
function mapCacheClear() {
  this.__data__ = {
    'hash': new Hash,
    'map': new (Map || ListCache),
    'string': new Hash
  };
}

/**
 * Removes `key` and its value from the map.
 *
 * @private
 * @name delete
 * @memberOf MapCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function mapCacheDelete(key) {
  return getMapData(this, key)['delete'](key);
}

/**
 * Gets the map value for `key`.
 *
 * @private
 * @name get
 * @memberOf MapCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function mapCacheGet(key) {
  return getMapData(this, key).get(key);
}

/**
 * Checks if a map value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf MapCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function mapCacheHas(key) {
  return getMapData(this, key).has(key);
}

/**
 * Sets the map `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf MapCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the map cache instance.
 */
function mapCacheSet(key, value) {
  getMapData(this, key).set(key, value);
  return this;
}

// Add methods to `MapCache`.
MapCache.prototype.clear = mapCacheClear;
MapCache.prototype['delete'] = mapCacheDelete;
MapCache.prototype.get = mapCacheGet;
MapCache.prototype.has = mapCacheHas;
MapCache.prototype.set = mapCacheSet;

/**
 * Creates a stack cache object to store key-value pairs.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function Stack(entries) {
  this.__data__ = new ListCache(entries);
}

/**
 * Removes all key-value entries from the stack.
 *
 * @private
 * @name clear
 * @memberOf Stack
 */
function stackClear() {
  this.__data__ = new ListCache;
}

/**
 * Removes `key` and its value from the stack.
 *
 * @private
 * @name delete
 * @memberOf Stack
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function stackDelete(key) {
  return this.__data__['delete'](key);
}

/**
 * Gets the stack value for `key`.
 *
 * @private
 * @name get
 * @memberOf Stack
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function stackGet(key) {
  return this.__data__.get(key);
}

/**
 * Checks if a stack value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf Stack
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function stackHas(key) {
  return this.__data__.has(key);
}

/**
 * Sets the stack `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf Stack
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the stack cache instance.
 */
function stackSet(key, value) {
  var cache = this.__data__;
  if (cache instanceof ListCache) {
    var pairs = cache.__data__;
    if (!Map || (pairs.length < LARGE_ARRAY_SIZE - 1)) {
      pairs.push([key, value]);
      return this;
    }
    cache = this.__data__ = new MapCache(pairs);
  }
  cache.set(key, value);
  return this;
}

// Add methods to `Stack`.
Stack.prototype.clear = stackClear;
Stack.prototype['delete'] = stackDelete;
Stack.prototype.get = stackGet;
Stack.prototype.has = stackHas;
Stack.prototype.set = stackSet;

/**
 * Creates an array of the enumerable property names of the array-like `value`.
 *
 * @private
 * @param {*} value The value to query.
 * @param {boolean} inherited Specify returning inherited property names.
 * @returns {Array} Returns the array of property names.
 */
function arrayLikeKeys(value, inherited) {
  // Safari 8.1 makes `arguments.callee` enumerable in strict mode.
  // Safari 9 makes `arguments.length` enumerable in strict mode.
  var result = (isArray(value) || isArguments(value))
    ? baseTimes(value.length, String)
    : [];

  var length = result.length,
      skipIndexes = !!length;

  for (var key in value) {
    if ((inherited || hasOwnProperty.call(value, key)) &&
        !(skipIndexes && (key == 'length' || isIndex(key, length)))) {
      result.push(key);
    }
  }
  return result;
}

/**
 * Assigns `value` to `key` of `object` if the existing value is not equivalent
 * using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
 * for equality comparisons.
 *
 * @private
 * @param {Object} object The object to modify.
 * @param {string} key The key of the property to assign.
 * @param {*} value The value to assign.
 */
function assignValue(object, key, value) {
  var objValue = object[key];
  if (!(hasOwnProperty.call(object, key) && eq(objValue, value)) ||
      (value === undefined && !(key in object))) {
    object[key] = value;
  }
}

/**
 * Gets the index at which the `key` is found in `array` of key-value pairs.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} key The key to search for.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function assocIndexOf(array, key) {
  var length = array.length;
  while (length--) {
    if (eq(array[length][0], key)) {
      return length;
    }
  }
  return -1;
}

/**
 * The base implementation of `_.assign` without support for multiple sources
 * or `customizer` functions.
 *
 * @private
 * @param {Object} object The destination object.
 * @param {Object} source The source object.
 * @returns {Object} Returns `object`.
 */
function baseAssign(object, source) {
  return object && copyObject(source, keys(source), object);
}

/**
 * The base implementation of `_.clone` and `_.cloneDeep` which tracks
 * traversed objects.
 *
 * @private
 * @param {*} value The value to clone.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @param {boolean} [isFull] Specify a clone including symbols.
 * @param {Function} [customizer] The function to customize cloning.
 * @param {string} [key] The key of `value`.
 * @param {Object} [object] The parent object of `value`.
 * @param {Object} [stack] Tracks traversed objects and their clone counterparts.
 * @returns {*} Returns the cloned value.
 */
function baseClone(value, isDeep, isFull, customizer, key, object, stack) {
  var result;
  if (customizer) {
    result = object ? customizer(value, key, object, stack) : customizer(value);
  }
  if (result !== undefined) {
    return result;
  }
  if (!isObject(value)) {
    return value;
  }
  var isArr = isArray(value);
  if (isArr) {
    result = initCloneArray(value);
    if (!isDeep) {
      return copyArray(value, result);
    }
  } else {
    var tag = getTag(value),
        isFunc = tag == funcTag || tag == genTag;

    if (isBuffer(value)) {
      return cloneBuffer(value, isDeep);
    }
    if (tag == objectTag || tag == argsTag || (isFunc && !object)) {
      if (isHostObject(value)) {
        return object ? value : {};
      }
      result = initCloneObject(isFunc ? {} : value);
      if (!isDeep) {
        return copySymbols(value, baseAssign(result, value));
      }
    } else {
      if (!cloneableTags[tag]) {
        return object ? value : {};
      }
      result = initCloneByTag(value, tag, baseClone, isDeep);
    }
  }
  // Check for circular references and return its corresponding clone.
  stack || (stack = new Stack);
  var stacked = stack.get(value);
  if (stacked) {
    return stacked;
  }
  stack.set(value, result);

  if (!isArr) {
    var props = isFull ? getAllKeys(value) : keys(value);
  }
  arrayEach(props || value, function(subValue, key) {
    if (props) {
      key = subValue;
      subValue = value[key];
    }
    // Recursively populate clone (susceptible to call stack limits).
    assignValue(result, key, baseClone(subValue, isDeep, isFull, customizer, key, value, stack));
  });
  return result;
}

/**
 * The base implementation of `_.create` without support for assigning
 * properties to the created object.
 *
 * @private
 * @param {Object} prototype The object to inherit from.
 * @returns {Object} Returns the new object.
 */
function baseCreate(proto) {
  return isObject(proto) ? objectCreate(proto) : {};
}

/**
 * The base implementation of `getAllKeys` and `getAllKeysIn` which uses
 * `keysFunc` and `symbolsFunc` to get the enumerable property names and
 * symbols of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {Function} keysFunc The function to get the keys of `object`.
 * @param {Function} symbolsFunc The function to get the symbols of `object`.
 * @returns {Array} Returns the array of property names and symbols.
 */
function baseGetAllKeys(object, keysFunc, symbolsFunc) {
  var result = keysFunc(object);
  return isArray(object) ? result : arrayPush(result, symbolsFunc(object));
}

/**
 * The base implementation of `getTag`.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
function baseGetTag(value) {
  return objectToString.call(value);
}

/**
 * The base implementation of `_.isNative` without bad shim checks.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a native function,
 *  else `false`.
 */
function baseIsNative(value) {
  if (!isObject(value) || isMasked(value)) {
    return false;
  }
  var pattern = (isFunction(value) || isHostObject(value)) ? reIsNative : reIsHostCtor;
  return pattern.test(toSource(value));
}

/**
 * The base implementation of `_.keys` which doesn't treat sparse arrays as dense.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 */
function baseKeys(object) {
  if (!isPrototype(object)) {
    return nativeKeys(object);
  }
  var result = [];
  for (var key in Object(object)) {
    if (hasOwnProperty.call(object, key) && key != 'constructor') {
      result.push(key);
    }
  }
  return result;
}

/**
 * Creates a clone of  `buffer`.
 *
 * @private
 * @param {Buffer} buffer The buffer to clone.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Buffer} Returns the cloned buffer.
 */
function cloneBuffer(buffer, isDeep) {
  if (isDeep) {
    return buffer.slice();
  }
  var result = new buffer.constructor(buffer.length);
  buffer.copy(result);
  return result;
}

/**
 * Creates a clone of `arrayBuffer`.
 *
 * @private
 * @param {ArrayBuffer} arrayBuffer The array buffer to clone.
 * @returns {ArrayBuffer} Returns the cloned array buffer.
 */
function cloneArrayBuffer(arrayBuffer) {
  var result = new arrayBuffer.constructor(arrayBuffer.byteLength);
  new Uint8Array(result).set(new Uint8Array(arrayBuffer));
  return result;
}

/**
 * Creates a clone of `dataView`.
 *
 * @private
 * @param {Object} dataView The data view to clone.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Object} Returns the cloned data view.
 */
function cloneDataView(dataView, isDeep) {
  var buffer = isDeep ? cloneArrayBuffer(dataView.buffer) : dataView.buffer;
  return new dataView.constructor(buffer, dataView.byteOffset, dataView.byteLength);
}

/**
 * Creates a clone of `map`.
 *
 * @private
 * @param {Object} map The map to clone.
 * @param {Function} cloneFunc The function to clone values.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Object} Returns the cloned map.
 */
function cloneMap(map, isDeep, cloneFunc) {
  var array = isDeep ? cloneFunc(mapToArray(map), true) : mapToArray(map);
  return arrayReduce(array, addMapEntry, new map.constructor);
}

/**
 * Creates a clone of `regexp`.
 *
 * @private
 * @param {Object} regexp The regexp to clone.
 * @returns {Object} Returns the cloned regexp.
 */
function cloneRegExp(regexp) {
  var result = new regexp.constructor(regexp.source, reFlags.exec(regexp));
  result.lastIndex = regexp.lastIndex;
  return result;
}

/**
 * Creates a clone of `set`.
 *
 * @private
 * @param {Object} set The set to clone.
 * @param {Function} cloneFunc The function to clone values.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Object} Returns the cloned set.
 */
function cloneSet(set, isDeep, cloneFunc) {
  var array = isDeep ? cloneFunc(setToArray(set), true) : setToArray(set);
  return arrayReduce(array, addSetEntry, new set.constructor);
}

/**
 * Creates a clone of the `symbol` object.
 *
 * @private
 * @param {Object} symbol The symbol object to clone.
 * @returns {Object} Returns the cloned symbol object.
 */
function cloneSymbol(symbol) {
  return symbolValueOf ? Object(symbolValueOf.call(symbol)) : {};
}

/**
 * Creates a clone of `typedArray`.
 *
 * @private
 * @param {Object} typedArray The typed array to clone.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Object} Returns the cloned typed array.
 */
function cloneTypedArray(typedArray, isDeep) {
  var buffer = isDeep ? cloneArrayBuffer(typedArray.buffer) : typedArray.buffer;
  return new typedArray.constructor(buffer, typedArray.byteOffset, typedArray.length);
}

/**
 * Copies the values of `source` to `array`.
 *
 * @private
 * @param {Array} source The array to copy values from.
 * @param {Array} [array=[]] The array to copy values to.
 * @returns {Array} Returns `array`.
 */
function copyArray(source, array) {
  var index = -1,
      length = source.length;

  array || (array = Array(length));
  while (++index < length) {
    array[index] = source[index];
  }
  return array;
}

/**
 * Copies properties of `source` to `object`.
 *
 * @private
 * @param {Object} source The object to copy properties from.
 * @param {Array} props The property identifiers to copy.
 * @param {Object} [object={}] The object to copy properties to.
 * @param {Function} [customizer] The function to customize copied values.
 * @returns {Object} Returns `object`.
 */
function copyObject(source, props, object, customizer) {
  object || (object = {});

  var index = -1,
      length = props.length;

  while (++index < length) {
    var key = props[index];

    var newValue = customizer
      ? customizer(object[key], source[key], key, object, source)
      : undefined;

    assignValue(object, key, newValue === undefined ? source[key] : newValue);
  }
  return object;
}

/**
 * Copies own symbol properties of `source` to `object`.
 *
 * @private
 * @param {Object} source The object to copy symbols from.
 * @param {Object} [object={}] The object to copy symbols to.
 * @returns {Object} Returns `object`.
 */
function copySymbols(source, object) {
  return copyObject(source, getSymbols(source), object);
}

/**
 * Creates an array of own enumerable property names and symbols of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names and symbols.
 */
function getAllKeys(object) {
  return baseGetAllKeys(object, keys, getSymbols);
}

/**
 * Gets the data for `map`.
 *
 * @private
 * @param {Object} map The map to query.
 * @param {string} key The reference key.
 * @returns {*} Returns the map data.
 */
function getMapData(map, key) {
  var data = map.__data__;
  return isKeyable(key)
    ? data[typeof key == 'string' ? 'string' : 'hash']
    : data.map;
}

/**
 * Gets the native function at `key` of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {string} key The key of the method to get.
 * @returns {*} Returns the function if it's native, else `undefined`.
 */
function getNative(object, key) {
  var value = getValue(object, key);
  return baseIsNative(value) ? value : undefined;
}

/**
 * Creates an array of the own enumerable symbol properties of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of symbols.
 */
var getSymbols = nativeGetSymbols ? overArg(nativeGetSymbols, Object) : stubArray;

/**
 * Gets the `toStringTag` of `value`.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
var getTag = baseGetTag;

// Fallback for data views, maps, sets, and weak maps in IE 11,
// for data views in Edge < 14, and promises in Node.js.
if ((DataView && getTag(new DataView(new ArrayBuffer(1))) != dataViewTag) ||
    (Map && getTag(new Map) != mapTag) ||
    (Promise && getTag(Promise.resolve()) != promiseTag) ||
    (Set && getTag(new Set) != setTag) ||
    (WeakMap && getTag(new WeakMap) != weakMapTag)) {
  getTag = function(value) {
    var result = objectToString.call(value),
        Ctor = result == objectTag ? value.constructor : undefined,
        ctorString = Ctor ? toSource(Ctor) : undefined;

    if (ctorString) {
      switch (ctorString) {
        case dataViewCtorString: return dataViewTag;
        case mapCtorString: return mapTag;
        case promiseCtorString: return promiseTag;
        case setCtorString: return setTag;
        case weakMapCtorString: return weakMapTag;
      }
    }
    return result;
  };
}

/**
 * Initializes an array clone.
 *
 * @private
 * @param {Array} array The array to clone.
 * @returns {Array} Returns the initialized clone.
 */
function initCloneArray(array) {
  var length = array.length,
      result = array.constructor(length);

  // Add properties assigned by `RegExp#exec`.
  if (length && typeof array[0] == 'string' && hasOwnProperty.call(array, 'index')) {
    result.index = array.index;
    result.input = array.input;
  }
  return result;
}

/**
 * Initializes an object clone.
 *
 * @private
 * @param {Object} object The object to clone.
 * @returns {Object} Returns the initialized clone.
 */
function initCloneObject(object) {
  return (typeof object.constructor == 'function' && !isPrototype(object))
    ? baseCreate(getPrototype(object))
    : {};
}

/**
 * Initializes an object clone based on its `toStringTag`.
 *
 * **Note:** This function only supports cloning values with tags of
 * `Boolean`, `Date`, `Error`, `Number`, `RegExp`, or `String`.
 *
 * @private
 * @param {Object} object The object to clone.
 * @param {string} tag The `toStringTag` of the object to clone.
 * @param {Function} cloneFunc The function to clone values.
 * @param {boolean} [isDeep] Specify a deep clone.
 * @returns {Object} Returns the initialized clone.
 */
function initCloneByTag(object, tag, cloneFunc, isDeep) {
  var Ctor = object.constructor;
  switch (tag) {
    case arrayBufferTag:
      return cloneArrayBuffer(object);

    case boolTag:
    case dateTag:
      return new Ctor(+object);

    case dataViewTag:
      return cloneDataView(object, isDeep);

    case float32Tag: case float64Tag:
    case int8Tag: case int16Tag: case int32Tag:
    case uint8Tag: case uint8ClampedTag: case uint16Tag: case uint32Tag:
      return cloneTypedArray(object, isDeep);

    case mapTag:
      return cloneMap(object, isDeep, cloneFunc);

    case numberTag:
    case stringTag:
      return new Ctor(object);

    case regexpTag:
      return cloneRegExp(object);

    case setTag:
      return cloneSet(object, isDeep, cloneFunc);

    case symbolTag:
      return cloneSymbol(object);
  }
}

/**
 * Checks if `value` is a valid array-like index.
 *
 * @private
 * @param {*} value The value to check.
 * @param {number} [length=MAX_SAFE_INTEGER] The upper bounds of a valid index.
 * @returns {boolean} Returns `true` if `value` is a valid index, else `false`.
 */
function isIndex(value, length) {
  length = length == null ? MAX_SAFE_INTEGER : length;
  return !!length &&
    (typeof value == 'number' || reIsUint.test(value)) &&
    (value > -1 && value % 1 == 0 && value < length);
}

/**
 * Checks if `value` is suitable for use as unique object key.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is suitable, else `false`.
 */
function isKeyable(value) {
  var type = typeof value;
  return (type == 'string' || type == 'number' || type == 'symbol' || type == 'boolean')
    ? (value !== '__proto__')
    : (value === null);
}

/**
 * Checks if `func` has its source masked.
 *
 * @private
 * @param {Function} func The function to check.
 * @returns {boolean} Returns `true` if `func` is masked, else `false`.
 */
function isMasked(func) {
  return !!maskSrcKey && (maskSrcKey in func);
}

/**
 * Checks if `value` is likely a prototype object.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a prototype, else `false`.
 */
function isPrototype(value) {
  var Ctor = value && value.constructor,
      proto = (typeof Ctor == 'function' && Ctor.prototype) || objectProto;

  return value === proto;
}

/**
 * Converts `func` to its source code.
 *
 * @private
 * @param {Function} func The function to process.
 * @returns {string} Returns the source code.
 */
function toSource(func) {
  if (func != null) {
    try {
      return funcToString.call(func);
    } catch (e) {}
    try {
      return (func + '');
    } catch (e) {}
  }
  return '';
}

/**
 * This method is like `_.clone` except that it recursively clones `value`.
 *
 * @static
 * @memberOf _
 * @since 1.0.0
 * @category Lang
 * @param {*} value The value to recursively clone.
 * @returns {*} Returns the deep cloned value.
 * @see _.clone
 * @example
 *
 * var objects = [{ 'a': 1 }, { 'b': 2 }];
 *
 * var deep = _.cloneDeep(objects);
 * console.log(deep[0] === objects[0]);
 * // => false
 */
function cloneDeep(value) {
  return baseClone(value, true, true);
}

/**
 * Performs a
 * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
 * comparison between two values to determine if they are equivalent.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to compare.
 * @param {*} other The other value to compare.
 * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
 * @example
 *
 * var object = { 'a': 1 };
 * var other = { 'a': 1 };
 *
 * _.eq(object, object);
 * // => true
 *
 * _.eq(object, other);
 * // => false
 *
 * _.eq('a', 'a');
 * // => true
 *
 * _.eq('a', Object('a'));
 * // => false
 *
 * _.eq(NaN, NaN);
 * // => true
 */
function eq(value, other) {
  return value === other || (value !== value && other !== other);
}

/**
 * Checks if `value` is likely an `arguments` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an `arguments` object,
 *  else `false`.
 * @example
 *
 * _.isArguments(function() { return arguments; }());
 * // => true
 *
 * _.isArguments([1, 2, 3]);
 * // => false
 */
function isArguments(value) {
  // Safari 8.1 makes `arguments.callee` enumerable in strict mode.
  return isArrayLikeObject(value) && hasOwnProperty.call(value, 'callee') &&
    (!propertyIsEnumerable.call(value, 'callee') || objectToString.call(value) == argsTag);
}

/**
 * Checks if `value` is classified as an `Array` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an array, else `false`.
 * @example
 *
 * _.isArray([1, 2, 3]);
 * // => true
 *
 * _.isArray(document.body.children);
 * // => false
 *
 * _.isArray('abc');
 * // => false
 *
 * _.isArray(_.noop);
 * // => false
 */
var isArray = Array.isArray;

/**
 * Checks if `value` is array-like. A value is considered array-like if it's
 * not a function and has a `value.length` that's an integer greater than or
 * equal to `0` and less than or equal to `Number.MAX_SAFE_INTEGER`.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is array-like, else `false`.
 * @example
 *
 * _.isArrayLike([1, 2, 3]);
 * // => true
 *
 * _.isArrayLike(document.body.children);
 * // => true
 *
 * _.isArrayLike('abc');
 * // => true
 *
 * _.isArrayLike(_.noop);
 * // => false
 */
function isArrayLike(value) {
  return value != null && isLength(value.length) && !isFunction(value);
}

/**
 * This method is like `_.isArrayLike` except that it also checks if `value`
 * is an object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an array-like object,
 *  else `false`.
 * @example
 *
 * _.isArrayLikeObject([1, 2, 3]);
 * // => true
 *
 * _.isArrayLikeObject(document.body.children);
 * // => true
 *
 * _.isArrayLikeObject('abc');
 * // => false
 *
 * _.isArrayLikeObject(_.noop);
 * // => false
 */
function isArrayLikeObject(value) {
  return isObjectLike(value) && isArrayLike(value);
}

/**
 * Checks if `value` is a buffer.
 *
 * @static
 * @memberOf _
 * @since 4.3.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a buffer, else `false`.
 * @example
 *
 * _.isBuffer(new Buffer(2));
 * // => true
 *
 * _.isBuffer(new Uint8Array(2));
 * // => false
 */
var isBuffer = nativeIsBuffer || stubFalse;

/**
 * Checks if `value` is classified as a `Function` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a function, else `false`.
 * @example
 *
 * _.isFunction(_);
 * // => true
 *
 * _.isFunction(/abc/);
 * // => false
 */
function isFunction(value) {
  // The use of `Object#toString` avoids issues with the `typeof` operator
  // in Safari 8-9 which returns 'object' for typed array and other constructors.
  var tag = isObject(value) ? objectToString.call(value) : '';
  return tag == funcTag || tag == genTag;
}

/**
 * Checks if `value` is a valid array-like length.
 *
 * **Note:** This method is loosely based on
 * [`ToLength`](http://ecma-international.org/ecma-262/7.0/#sec-tolength).
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a valid length, else `false`.
 * @example
 *
 * _.isLength(3);
 * // => true
 *
 * _.isLength(Number.MIN_VALUE);
 * // => false
 *
 * _.isLength(Infinity);
 * // => false
 *
 * _.isLength('3');
 * // => false
 */
function isLength(value) {
  return typeof value == 'number' &&
    value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
}

/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return !!value && (type == 'object' || type == 'function');
}

/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return !!value && typeof value == 'object';
}

/**
 * Creates an array of the own enumerable property names of `object`.
 *
 * **Note:** Non-object values are coerced to objects. See the
 * [ES spec](http://ecma-international.org/ecma-262/7.0/#sec-object.keys)
 * for more details.
 *
 * @static
 * @since 0.1.0
 * @memberOf _
 * @category Object
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 * @example
 *
 * function Foo() {
 *   this.a = 1;
 *   this.b = 2;
 * }
 *
 * Foo.prototype.c = 3;
 *
 * _.keys(new Foo);
 * // => ['a', 'b'] (iteration order is not guaranteed)
 *
 * _.keys('hi');
 * // => ['0', '1']
 */
function keys(object) {
  return isArrayLike(object) ? arrayLikeKeys(object) : baseKeys(object);
}

/**
 * This method returns a new empty array.
 *
 * @static
 * @memberOf _
 * @since 4.13.0
 * @category Util
 * @returns {Array} Returns the new empty array.
 * @example
 *
 * var arrays = _.times(2, _.stubArray);
 *
 * console.log(arrays);
 * // => [[], []]
 *
 * console.log(arrays[0] === arrays[1]);
 * // => false
 */
function stubArray() {
  return [];
}

/**
 * This method returns `false`.
 *
 * @static
 * @memberOf _
 * @since 4.13.0
 * @category Util
 * @returns {boolean} Returns `false`.
 * @example
 *
 * _.times(2, _.stubFalse);
 * // => [false, false]
 */
function stubFalse() {
  return false;
}

module.exports = cloneDeep;

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],51:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

/* global performance */
var perf = typeof performance !== 'undefined' && performance;

var now = perf && perf.now ? function () { return perf.now(); } : function () { return Date.now(); }

function throwIfEmpty (name) {
  if (!name) {
    throw new Error('name must be non-empty')
  }
}

// simple binary sort insertion
function insertSorted (arr, item) {
  var low = 0;
  var high = arr.length;
  var mid;
  while (low < high) {
    mid = (low + high) >>> 1; // like (num / 2) but faster
    if (arr[mid].startTime < item.startTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  arr.splice(low, 0, item);
}

exports.mark = void 0;
exports.stop = void 0;
exports.getEntries = void 0;
exports.clear = void 0;

if (
  perf &&
  perf.mark &&
  perf.getEntriesByName &&
  perf.getEntriesByType &&
  perf.clearMeasures
) {
  exports.mark = function (name) {
    throwIfEmpty(name);
    perf.mark(("start " + name));
  };
  exports.stop = function (name) {
    throwIfEmpty(name);
    perf.mark(("end " + name));
    perf.measure(name, ("start " + name), ("end " + name));
    var entries = perf.getEntriesByName(name);
    return entries[entries.length - 1]
  };
  exports.getEntries = function () { return perf.getEntriesByType('measure'); };
  exports.clear = function () {
    perf.clearMarks();
    perf.clearMeasures();
  };
} else {
  var marks = {};
  var entries = [];
  exports.mark = function (name) {
    throwIfEmpty(name);
    var startTime = now();
    marks['$' + name] = startTime;
  };
  exports.stop = function (name) {
    throwIfEmpty(name);
    var endTime = now();
    var startTime = marks['$' + name];
    if (!startTime) {
      throw new Error(("no known mark: " + name))
    }
    var entry = {
      startTime: startTime,
      name: name,
      duration: endTime - startTime,
      entryType: 'measure'
    };
    // per the spec this should be at least 150:
    // https://www.w3.org/TR/resource-timing-1/#extensions-performance-interface
    // we just have no limit, per Chrome and Edge's de-facto behavior
    insertSorted(entries, entry);
    return entry
  };
  exports.getEntries = function () { return entries; };
  exports.clear = function () {
    marks = {};
    entries = [];
  };
}

},{}],52:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[1])(1)
});
