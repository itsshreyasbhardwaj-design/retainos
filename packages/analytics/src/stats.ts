/**
 * Statistics for ImpactLab.
 *
 * Implemented from scratch rather than pulled from a dependency, because every
 * number RetainOS shows a founder is used to make a product decision, and we
 * need to be able to say exactly how it was computed.
 *
 * Everything here is a pure function of its inputs. No clock, no database.
 */

/**
 * Standard normal CDF.
 *
 * Hart's rational approximation (1968), as refined by West. Accurate to about
 * 1e-15 across the whole range, including the far tails — which matters,
 * because that is exactly where small p-values live.
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * b) / d;
    } else {
      // Continued-fraction tail expansion.
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Complementary error function, expressed through the normal CDF. */
export function erfc(x: number): number {
  return 2 * normalCdf(-x * Math.SQRT2);
}

/** Error function. */
export function erf(x: number): number {
  return 1 - erfc(x);
}

/**
 * Inverse standard normal CDF (probit). Acklam's rational approximation with
 * one Halley refinement step; accurate to roughly 1e-15.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
             3.754408661907416];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
        (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
         ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // Halley refinement.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Natural log of the gamma function (Lanczos approximation). */
export function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5;
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j]! / ++y;
  return -tmp + (x + 0.5) * Math.log(tmp) + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised incomplete beta function I_x(a,b), by continued fraction. */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Use the symmetry relation I_x(a,b) = 1 - I_{1-x}(b,a) on the side where the
  // continued fraction converges quickly.
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(b, a, 1 - x);

  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );

  const TINY = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // Odd step.
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return (front * h) / a;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tDistTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/** Regularised lower incomplete gamma P(a,x). */
export function incompleteGammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    // Series representation.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n <= 300; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q(a,x), then complement.
  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return 1 - q;
}

/** Upper-tail p-value for a chi-square statistic. */
export function chiSquareP(chi2: number, df: number): number {
  if (chi2 <= 0 || df <= 0) return 1;
  return 1 - incompleteGammaP(df / 2, chi2 / 2);
}

export interface ProportionTest {
  controlRate: number;
  treatmentRate: number;
  absoluteDiff: number;
  relativeDiff: number | null;
  /** Two-sided p-value from a pooled two-proportion z-test. */
  pValue: number;
  zScore: number;
  /** Confidence interval for the absolute difference (unpooled standard error). */
  confidenceInterval: [number, number];
  confidenceLevel: number;
  /** False when either arm is too small for the normal approximation to hold. */
  normalApproximationValid: boolean;
}

/**
 * Two-proportion z-test.
 *
 * The pooled standard error is used for the p-value (correct under the null of
 * equal proportions) and the unpooled standard error for the interval (correct
 * when estimating the actual difference). Mixing those up is a common error
 * that produces an interval which disagrees with its own p-value.
 */
export function twoProportionTest(
  control: { successes: number; total: number },
  treatment: { successes: number; total: number },
  confidenceLevel = 0.95,
): ProportionTest | null {
  if (control.total <= 0 || treatment.total <= 0) return null;
  const p1 = control.successes / control.total;
  const p2 = treatment.successes / treatment.total;
  const pooled = (control.successes + treatment.successes) / (control.total + treatment.total);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / control.total + 1 / treatment.total));
  const z = sePooled === 0 ? 0 : (p2 - p1) / sePooled;
  const pValue = sePooled === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(z)));

  const seUnpooled = Math.sqrt((p1 * (1 - p1)) / control.total + (p2 * (1 - p2)) / treatment.total);
  const zCrit = normalQuantile(1 - (1 - confidenceLevel) / 2);
  const diff = p2 - p1;

  // The normal approximation needs enough expected successes and failures in
  // both arms. Below that threshold the p-value is not trustworthy and the
  // caller must not present it as one.
  const normalApproximationValid =
    control.total * p1 >= 5 && control.total * (1 - p1) >= 5 &&
    treatment.total * p2 >= 5 && treatment.total * (1 - p2) >= 5;

  return {
    controlRate: p1,
    treatmentRate: p2,
    absoluteDiff: diff,
    relativeDiff: p1 === 0 ? null : diff / p1,
    pValue: Math.min(1, Math.max(0, pValue)),
    zScore: z,
    confidenceInterval: [diff - zCrit * seUnpooled, diff + zCrit * seUnpooled],
    confidenceLevel,
    normalApproximationValid,
  };
}

/**
 * Wilson score interval for a single proportion.
 *
 * Preferred over the normal (Wald) interval because it stays inside [0,1] and
 * behaves sensibly at small n and at rates near 0 or 1 — exactly the conditions
 * an early-stage product's funnel metrics live in.
 */
export function wilsonInterval(successes: number, total: number, confidenceLevel = 0.95): [number, number] {
  if (total <= 0) return [0, 0];
  const z = normalQuantile(1 - (1 - confidenceLevel) / 2);
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  // Snap away floating-point dust so a zero-success interval reports exactly 0
  // rather than something like 2.8e-17, which reads as noise in a UI.
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v - 1) < 1e-12 ? 1 : v);
  return [snap(Math.max(0, centre - spread)), snap(Math.min(1, centre + spread))];
}

export interface MeanTest {
  controlMean: number;
  treatmentMean: number;
  absoluteDiff: number;
  relativeDiff: number | null;
  pValue: number;
  tStatistic: number;
  degreesOfFreedom: number;
  confidenceInterval: [number, number];
  confidenceLevel: number;
}

/**
 * Welch's t-test for two independent means.
 *
 * Welch rather than Student because equal variances between a control and a
 * treatment arm is an assumption we have no reason to make.
 */
export function welchTTest(
  control: { mean: number; variance: number; n: number },
  treatment: { mean: number; variance: number; n: number },
  confidenceLevel = 0.95,
): MeanTest | null {
  if (control.n < 2 || treatment.n < 2) return null;
  const a = control.variance / control.n;
  const b = treatment.variance / treatment.n;
  const se = Math.sqrt(a + b);
  if (se === 0) return null;
  const t = (treatment.mean - control.mean) / se;
  const df =
    (a + b) ** 2 /
    (a ** 2 / (control.n - 1) + b ** 2 / (treatment.n - 1));
  const p = tDistTwoSidedP(t, df);
  // Normal critical value is an acceptable interval approximation once df is
  // large; below that it is slightly narrow, which is noted in the docs.
  const crit = normalQuantile(1 - (1 - confidenceLevel) / 2);
  const diff = treatment.mean - control.mean;
  return {
    controlMean: control.mean,
    treatmentMean: treatment.mean,
    absoluteDiff: diff,
    relativeDiff: control.mean === 0 ? null : diff / control.mean,
    pValue: p,
    tStatistic: t,
    degreesOfFreedom: df,
    confidenceInterval: [diff - crit * se, diff + crit * se],
    confidenceLevel,
  };
}

export interface SrmCheck {
  observed: number[];
  expected: number[];
  chiSquare: number;
  pValue: number;
  /** True when the split differs from the configured weights more than chance explains. */
  mismatch: boolean;
}

/**
 * Sample ratio mismatch check.
 *
 * If a 50/50 experiment delivers 53/47 over 20,000 users, the assignment or
 * exposure logging is broken and the result means nothing. This is the single
 * most valuable experiment validity check and it runs on every analysis.
 */
export function sampleRatioMismatch(counts: number[], weights: number[], alpha = 0.001): SrmCheck | null {
  const total = counts.reduce((s, c) => s + c, 0);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || weightSum === 0 || counts.length !== weights.length) return null;
  const expected = weights.map((w) => (w / weightSum) * total);
  let chi2 = 0;
  for (let i = 0; i < counts.length; i++) {
    const e = expected[i]!;
    if (e <= 0) continue;
    chi2 += (counts[i]! - e) ** 2 / e;
  }
  const p = chiSquareP(chi2, counts.length - 1);
  // alpha is deliberately strict (0.001): a mismatch warning should mean
  // something is genuinely wrong, not fire on one experiment in twenty.
  return { observed: counts, expected, chiSquare: chi2, pValue: p, mismatch: p < alpha };
}

export interface MultipleComparisonResult {
  label: string;
  pValue: number;
  adjustedThreshold: number;
  significant: boolean;
}

/**
 * Holm-Bonferroni step-down correction.
 *
 * Applied across guardrail metrics so that "one of our eight guardrails moved"
 * is not reported as a finding when eight independent tests at alpha 0.05 would
 * produce one false positive about a third of the time.
 */
export function holmBonferroni(
  tests: Array<{ label: string; pValue: number }>,
  alpha = 0.05,
): MultipleComparisonResult[] {
  const sorted = [...tests].sort((a, b) => a.pValue - b.pValue);
  const m = sorted.length;
  const out: MultipleComparisonResult[] = [];
  let stillRejecting = true;
  for (let i = 0; i < m; i++) {
    const threshold = alpha / (m - i);
    const significant = stillRejecting && sorted[i]!.pValue <= threshold;
    if (!significant) stillRejecting = false;
    out.push({ label: sorted[i]!.label, pValue: sorted[i]!.pValue, adjustedThreshold: threshold, significant });
  }
  return out;
}

/**
 * Sample size per variant for a two-proportion test.
 * Standard formula at 80% power unless overridden.
 */
export function requiredSampleSize(
  baselineRate: number,
  minimumDetectableRelativeEffect: number,
  alpha = 0.05,
  power = 0.8,
): number {
  if (baselineRate <= 0 || baselineRate >= 1 || minimumDetectableRelativeEffect <= 0) return Infinity;
  const p1 = baselineRate;
  const p2 = Math.min(0.999999, p1 * (1 + minimumDetectableRelativeEffect));
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const numerator = (zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  return Math.ceil(numerator / (p2 - p1) ** 2);
}

/** Nearest-rank percentile. `p` is a fraction, e.g. 0.5 for the median. */
export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (p <= 0) return sortedValues[0]!;
  if (p >= 1) return sortedValues[sortedValues.length - 1]!;
  const rank = Math.ceil(p * sortedValues.length);
  return sortedValues[Math.max(0, rank - 1)]!;
}

export function median(sortedValues: number[]): number | null {
  const n = sortedValues.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sortedValues[(n - 1) / 2]!;
  return (sortedValues[n / 2 - 1]! + sortedValues[n / 2]!) / 2;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample variance (Bessel-corrected). */
export function variance(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values)!;
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
}
