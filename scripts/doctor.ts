import 'dotenv/config';
import { runHealthCheck, formatHealthReport } from '../src/doctor.js';

/**
 * Brownbot health check. Prints whether the second brain is live and whether the
 * proactive loops are firing, then exits non-zero if anything needs attention
 * (so it's usable as a monitoring probe).
 *
 * Usage: npm run doctor   (or: tsx scripts/doctor.ts)
 */

const report = runHealthCheck();
console.log(formatHealthReport(report));
process.exit(report.healthy ? 0 : 1);
