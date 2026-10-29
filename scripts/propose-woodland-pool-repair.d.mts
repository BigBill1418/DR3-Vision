// Type surface for scripts/propose-woodland-pool-repair.mjs (ADR-0143 item 8), so the
// vitest suite can import its pure planner and injectable proposer under allowJs:false.
export const PROPOSER: string;
export const REASON: string;
export interface RepairOpts {
  apply: boolean;
  siteCode: string;
  day: string;
  expectUnits: number;
}
export interface FloorStrings {
  program: string;
  nonProgram: string;
  total: string;
}
export interface RepairPlan {
  units: number;
  before: { program: number; nonProgram: number; total: number };
  after: { program: number; nonProgram: number; total: number };
}
export function parseArgs(argv: string[]): RepairOpts;
export class RepairRefused extends Error {}
export function planRepair(floor: FloorStrings, expectUnits: number): RepairPlan;
export function proposeRepair(
  prisma: unknown,
  opts: RepairOpts,
  probe?: (siteCode: string) => Promise<FloorStrings>,
): Promise<
  RepairPlan & { site: string; exceptionId: string; day: string; applied: boolean; adjustmentId: string | null }
>;
