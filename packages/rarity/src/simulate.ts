import { simulateRarity, type RaritySimulationOptions } from "./simulation.js";

const options = parseArgs(process.argv.slice(2));
const result = simulateRarity(options);

console.table(
  result.rows.map((row) => ({
    rarity: row.rarity,
    total: row.totalPulls,
    "pulls / stream": row.averagePerStream.toFixed(3),
    "streams / pull": row.averageStreamsPerPull?.toFixed(2) ?? "never"
  }))
);
console.log("Assumptions", result.options);

function parseArgs(args: string[]): RaritySimulationOptions {
  return {
    streams: readNumberFlag(args, "--streams", 120),
    pullsPerStream: readNumberFlag(args, "--pulls-per-stream", 400),
    runs: readNumberFlag(args, "--runs", 100),
    seed: readNumberFlag(args, "--seed", 42),
    daysBetweenStreams: readNumberFlag(args, "--days-between-streams", 1)
  };
}

function readNumberFlag(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
