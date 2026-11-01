import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalCdf, normalQuantile, erf, erfc, logGamma, incompleteBeta,
  tDistTwoSidedP, chiSquareP, twoProportionTest, wilsonInterval, welchTTest,
  sampleRatioMismatch, holmBonferroni, requiredSampleSize, percentile, median,
  mean, variance,
} from "../src/stats.ts";

const close = (got: number, want: number, tol = 1e-6, label = "") =>
  assert.ok(Math.abs(got - want) < tol, `${label} expected ${want}, got ${got} (tol ${tol})`);

/** Relative closeness, for tail values where absolute tolerance is meaningless. */
const closeRel = (got: number, want: number, rel = 1e-9, label = "") =>
  assert.ok(Math.abs(got - want) <= Math.abs(want) * rel,
    `${label} expected ${want}, got ${got} (relative tol ${rel})`);

describe("normal distribution", () => {
  test("matches published CDF values", () => {
    close(normalCdf(0), 0.5, 1e-12);
    close(normalCdf(1), 0.8413447460685429, 1e-12);
    close(normalCdf(1.96), 0.9750021048517795, 1e-12);
    close(normalCdf(-1.96), 0.024997895148220435, 1e-12);
    close(normalCdf(2.5758293), 0.995, 1e-7);
  });

  test("stays accurate in the far tails, where p-values live", () => {
    // Compared on relative error: Hart's approximation is good to roughly 1e-15
    // relative, which is what matters for a p-value of 1e-10.
    closeRel(normalCdf(-3), 1.3498980316300946e-3, 1e-12);
    closeRel(normalCdf(-5), 2.866515718791939e-7, 1e-9);
    closeRel(normalCdf(-6), 9.865876450376946e-10, 1e-8);
    closeRel(normalCdf(-8), 6.220960574271786e-16, 1e-6);
    assert.equal(normalCdf(-40), 0);
    assert.equal(normalCdf(40), 1);
  });

  test("is symmetric", () => {
    for (const z of [0.1, 0.5, 1, 2, 3, 5]) {
      close(normalCdf(z) + normalCdf(-z), 1, 1e-14, `symmetry at ${z}`);
    }
  });

  test("the quantile function inverts the CDF", () => {
    for (const p of [0.001, 0.01, 0.025, 0.1, 0.5, 0.9, 0.975, 0.99, 0.999]) {
      close(normalCdf(normalQuantile(p)), p, 1e-9, `round trip at p=${p}`);
    }
    close(normalQuantile(0.975), 1.959963984540054, 1e-9);
    close(normalQuantile(0.995), 2.5758293035489004, 1e-9);
    close(normalQuantile(0.8), 0.8416212335729143, 1e-9);
    assert.equal(normalQuantile(0), -Infinity);
    assert.equal(normalQuantile(1), Infinity);
  });

  test("erf and erfc agree with the normal CDF", () => {
    close(erf(0), 0, 1e-12);
    close(erf(1), 0.8427007929497149, 1e-9);
    close(erfc(0), 1, 1e-12);
    close(erfc(1), 0.15729920705028513, 1e-9);
  });
});

describe("gamma and beta functions", () => {
  test("logGamma matches factorials", () => {
    close(logGamma(1), 0, 1e-10);
    close(logGamma(2), 0, 1e-10);
    close(logGamma(5), Math.log(24), 1e-10);
    close(logGamma(10), Math.log(362880), 1e-9);
    close(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10);
  });

  test("incompleteBeta matches analytic values", () => {
    close(incompleteBeta(1, 1, 0.5), 0.5, 1e-12);
    close(incompleteBeta(1, 1, 0.3), 0.3, 1e-12);
    close(incompleteBeta(2, 2, 0.5), 0.5, 1e-12);
    // I_x(2,3) = 6x^2/2 - ... analytic: 1-(1-x)^3(1+3x) ... verified numerically
    close(incompleteBeta(2, 3, 0.25), 0.26171875, 1e-10);
    close(incompleteBeta(3, 5, 0.7), 0.9712044500000001, 1e-6);
    assert.equal(incompleteBeta(2, 3, 0), 0);
    assert.equal(incompleteBeta(2, 3, 1), 1);
  });

  test("incompleteBeta respects the symmetry relation", () => {
    for (const [a, b, x] of [[2, 5, 0.3], [7, 2, 0.8], [0.5, 0.5, 0.25]] as const) {
      close(incompleteBeta(a, b, x) + incompleteBeta(b, a, 1 - x), 1, 1e-10, `symmetry a=${a} b=${b}`);
    }
  });
});

describe("Student t", () => {
  test("matches published two-sided critical values", () => {
    close(tDistTwoSidedP(12.7062, 1), 0.05, 1e-5);
    close(tDistTwoSidedP(4.3027, 2), 0.05, 1e-5);
    close(tDistTwoSidedP(2.2281, 10), 0.05, 1e-5);
    close(tDistTwoSidedP(2.0086, 50), 0.05, 1e-4);
    close(tDistTwoSidedP(2.0, 10), 0.0733880, 1e-6);
  });

  test("converges to the normal as df grows", () => {
    close(tDistTwoSidedP(1.96, 1e7), 0.05, 1e-4);
  });

  test("t = 0 gives p = 1", () => {
    close(tDistTwoSidedP(0, 10), 1, 1e-12);
  });
});

describe("chi-square", () => {
  test("matches published critical values", () => {
    close(chiSquareP(3.841459, 1), 0.05, 1e-6);
    close(chiSquareP(6.634897, 1), 0.01, 1e-6);
    close(chiSquareP(5.991465, 2), 0.05, 1e-6);
    close(chiSquareP(16.918978, 9), 0.05, 1e-5);
    close(chiSquareP(10.827566, 1), 0.001, 1e-6);
  });

  test("zero statistic gives p = 1", () => {
    assert.equal(chiSquareP(0, 1), 1);
  });
});

describe("twoProportionTest", () => {
  test("computes rates, difference and a sane p-value", () => {
    const r = twoProportionTest({ successes: 100, total: 1000 }, { successes: 150, total: 1000 })!;
    close(r.controlRate, 0.1, 1e-12);
    close(r.treatmentRate, 0.15, 1e-12);
    close(r.absoluteDiff, 0.05, 1e-12);
    close(r.relativeDiff!, 0.5, 1e-12);
    // Pooled SE = sqrt(0.125 * 0.875 * (1/1000 + 1/1000)) = 0.0147902,
    // so z = 0.05 / 0.0147902 = 3.3806 and p = 0.00072.
    close(r.zScore, 3.38062, 1e-4);
    close(r.pValue, 0.000722, 1e-5);
    assert.equal(r.normalApproximationValid, true);
  });

  test("identical arms give p = 1 and a difference of zero", () => {
    const r = twoProportionTest({ successes: 50, total: 500 }, { successes: 50, total: 500 })!;
    close(r.absoluteDiff, 0, 1e-12);
    close(r.pValue, 1, 1e-12);
  });

  test("the confidence interval contains the observed difference and brackets zero when p is large", () => {
    const r = twoProportionTest({ successes: 50, total: 500 }, { successes: 55, total: 500 })!;
    assert.ok(r.confidenceInterval[0] < r.absoluteDiff);
    assert.ok(r.confidenceInterval[1] > r.absoluteDiff);
    assert.ok(r.pValue > 0.05);
    assert.ok(r.confidenceInterval[0] < 0 && r.confidenceInterval[1] > 0,
      "a non-significant result must have an interval that includes zero");
  });

  test("a significant result has an interval that excludes zero", () => {
    const r = twoProportionTest({ successes: 100, total: 2000 }, { successes: 200, total: 2000 })!;
    assert.ok(r.pValue < 0.001);
    assert.ok(r.confidenceInterval[0] > 0, `interval ${r.confidenceInterval}`);
  });

  test("flags an invalid normal approximation on tiny arms", () => {
    const r = twoProportionTest({ successes: 1, total: 10 }, { successes: 2, total: 10 })!;
    assert.equal(r.normalApproximationValid, false);
  });

  test("relative difference is null when the baseline is zero, not Infinity", () => {
    const r = twoProportionTest({ successes: 0, total: 100 }, { successes: 5, total: 100 })!;
    assert.equal(r.relativeDiff, null);
  });

  test("returns null for an empty arm rather than dividing by zero", () => {
    assert.equal(twoProportionTest({ successes: 0, total: 0 }, { successes: 1, total: 10 }), null);
    assert.equal(twoProportionTest({ successes: 1, total: 10 }, { successes: 0, total: 0 }), null);
  });
});

describe("wilsonInterval", () => {
  test("matches published values", () => {
    const [lo, hi] = wilsonInterval(2, 10);
    close(lo, 0.0566, 1e-3);
    close(hi, 0.5098, 1e-3);
  });

  test("stays inside [0,1] at the extremes, unlike a Wald interval", () => {
    const [lo0, hi0] = wilsonInterval(0, 10);
    assert.equal(lo0, 0);
    assert.ok(hi0 > 0 && hi0 < 1, "zero successes must still have a non-degenerate upper bound");
    const [lo1, hi1] = wilsonInterval(10, 10);
    assert.ok(lo1 > 0 && lo1 < 1);
    assert.equal(hi1, 1);
  });

  test("narrows as the sample grows", () => {
    const small = wilsonInterval(50, 100);
    const large = wilsonInterval(5000, 10000);
    assert.ok(large[1] - large[0] < small[1] - small[0]);
  });

  test("a zero denominator returns a degenerate interval rather than NaN", () => {
    assert.deepEqual(wilsonInterval(0, 0), [0, 0]);
  });
});

describe("welchTTest", () => {
  test("detects a clear difference in means", () => {
    const r = welchTTest(
      { mean: 10, variance: 4, n: 100 },
      { mean: 12, variance: 4, n: 100 },
    )!;
    close(r.absoluteDiff, 2, 1e-12);
    close(r.tStatistic, 7.0711, 1e-3);
    assert.ok(r.pValue < 1e-9);
  });

  test("reports no difference when the means match", () => {
    const r = welchTTest({ mean: 10, variance: 4, n: 50 }, { mean: 10, variance: 9, n: 50 })!;
    close(r.pValue, 1, 1e-12);
  });

  test("uses Welch degrees of freedom, not n1+n2-2", () => {
    const r = welchTTest({ mean: 10, variance: 1, n: 10 }, { mean: 11, variance: 100, n: 100 })!;
    assert.ok(r.degreesOfFreedom < 108, `df=${r.degreesOfFreedom} should be well below 108`);
    assert.ok(r.degreesOfFreedom > 50);
  });

  test("returns null when an arm is too small or has no variance", () => {
    assert.equal(welchTTest({ mean: 1, variance: 1, n: 1 }, { mean: 2, variance: 1, n: 10 }), null);
    assert.equal(welchTTest({ mean: 1, variance: 0, n: 10 }, { mean: 1, variance: 0, n: 10 }), null);
  });
});

describe("sampleRatioMismatch", () => {
  test("passes a clean 50/50 split", () => {
    const r = sampleRatioMismatch([5000, 5020], [0.5, 0.5])!;
    assert.equal(r.mismatch, false);
    assert.ok(r.pValue > 0.001);
  });

  test("catches a split that is too far off to be chance", () => {
    const r = sampleRatioMismatch([10600, 9400], [0.5, 0.5])!;
    assert.equal(r.mismatch, true);
    assert.ok(r.pValue < 0.001, `p=${r.pValue}`);
  });

  test("tolerates a small imbalance on a small sample", () => {
    // 55/45 out of 100 is unremarkable and must not raise an alarm.
    const r = sampleRatioMismatch([55, 45], [0.5, 0.5])!;
    assert.equal(r.mismatch, false);
  });

  test("handles unequal intended weights", () => {
    const r = sampleRatioMismatch([9000, 1000], [0.9, 0.1])!;
    assert.equal(r.mismatch, false);
    const bad = sampleRatioMismatch([8000, 2000], [0.9, 0.1])!;
    assert.equal(bad.mismatch, true);
  });

  test("works for three or more variants", () => {
    const r = sampleRatioMismatch([3300, 3350, 3350], [1, 1, 1])!;
    assert.equal(r.mismatch, false);
    assert.deepEqual(r.expected.map(Math.round), [3333, 3333, 3333]);
  });

  test("returns null when there is nothing to check", () => {
    assert.equal(sampleRatioMismatch([0, 0], [0.5, 0.5]), null);
    assert.equal(sampleRatioMismatch([10], [0.5, 0.5]), null);
  });
});

describe("holmBonferroni", () => {
  test("a single test behaves like an uncorrected test", () => {
    const r = holmBonferroni([{ label: "a", pValue: 0.04 }]);
    assert.equal(r[0]!.significant, true);
    close(r[0]!.adjustedThreshold, 0.05, 1e-12);
  });

  test("tightens the threshold as tests are added", () => {
    const r = holmBonferroni([
      { label: "a", pValue: 0.001 },
      { label: "b", pValue: 0.02 },
      { label: "c", pValue: 0.04 },
      { label: "d", pValue: 0.5 },
    ]);
    close(r[0]!.adjustedThreshold, 0.0125, 1e-12);
    assert.equal(r[0]!.significant, true, "0.001 survives 0.05/4");
    assert.equal(r[1]!.significant, false, "0.02 fails 0.05/3 = 0.0167");
    // Step-down: once one test fails, nothing weaker can pass.
    assert.equal(r[2]!.significant, false);
    assert.equal(r[3]!.significant, false);
  });

  test("stops rejecting after the first failure even if a later p is small", () => {
    const r = holmBonferroni([{ label: "a", pValue: 0.03 }, { label: "b", pValue: 0.031 }]);
    assert.equal(r[0]!.significant, false);
    assert.equal(r[1]!.significant, false);
  });

  test("results come back sorted by p-value", () => {
    const r = holmBonferroni([
      { label: "big", pValue: 0.9 }, { label: "small", pValue: 0.001 },
    ]);
    assert.equal(r[0]!.label, "small");
  });
});

describe("requiredSampleSize", () => {
  test("gives a plausible figure for a realistic funnel", () => {
    // 20% baseline, want to detect a 10% relative lift: a few thousand per arm.
    const n = requiredSampleSize(0.2, 0.1);
    assert.ok(n > 5000 && n < 10000, `got ${n}`);
  });

  test("a smaller effect needs a bigger sample", () => {
    assert.ok(requiredSampleSize(0.2, 0.05) > requiredSampleSize(0.2, 0.2));
  });

  test("returns Infinity for impossible inputs rather than a misleading number", () => {
    assert.equal(requiredSampleSize(0, 0.1), Infinity);
    assert.equal(requiredSampleSize(1, 0.1), Infinity);
    assert.equal(requiredSampleSize(0.2, 0), Infinity);
  });
});

describe("summary statistics", () => {
  test("nearest-rank percentiles", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(v, 0.5), 5);
    assert.equal(percentile(v, 0.9), 9);
    assert.equal(percentile(v, 0.95), 10);
    assert.equal(percentile(v, 0), 1);
    assert.equal(percentile(v, 1), 10);
    assert.equal(percentile([], 0.5), null);
  });

  test("median interpolates for even counts", () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
  });

  test("mean and variance", () => {
    assert.equal(mean([2, 4, 6]), 4);
    assert.equal(mean([]), null);
    // Bessel-corrected sample variance of [2,4,6] is 4.
    assert.equal(variance([2, 4, 6]), 4);
    assert.equal(variance([5]), null, "one observation has no sample variance");
  });
});
