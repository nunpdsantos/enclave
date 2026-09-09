import { Difficulty } from './Config';

export interface ProgressTier {
  minScore: number;
  label: string;
  color: number;
}

export const PROGRESS_TIERS: Record<Difficulty, ProgressTier[]> = {
  classic: [
    { minScore: 0, label: 'SETTLER', color: 0x3b82f6 },
    { minScore: 1500, label: 'BUILDER', color: 0x10b981 },
    { minScore: 4000, label: 'ARCHITECT', color: 0xfbbf24 },
    { minScore: 9000, label: 'WARDEN', color: 0xf59e0b },
    { minScore: 18000, label: 'SOVEREIGN', color: 0xef4444 },
    { minScore: 35000, label: 'LEGEND', color: 0xd946ef },
  ],
  blitz: [
    { minScore: 0, label: 'SETTLER', color: 0x3b82f6 },
    { minScore: 800, label: 'BUILDER', color: 0x10b981 },
    { minScore: 2200, label: 'ARCHITECT', color: 0xfbbf24 },
    { minScore: 5000, label: 'WARDEN', color: 0xf59e0b },
    { minScore: 10000, label: 'SOVEREIGN', color: 0xef4444 },
    { minScore: 20000, label: 'LEGEND', color: 0xd946ef },
  ],
  // Thirty pieces with no clock: a careful run out-scores a fast one, but it
  // cannot out-last one, so the ladder sits between Blitz and Classic. First
  // pass, tunable once the telemetry says where daily scores actually land.
  daily: [
    { minScore: 0, label: 'SETTLER', color: 0x3b82f6 },
    { minScore: 600, label: 'BUILDER', color: 0x10b981 },
    { minScore: 1600, label: 'ARCHITECT', color: 0xfbbf24 },
    { minScore: 3500, label: 'WARDEN', color: 0xf59e0b },
    { minScore: 7000, label: 'SOVEREIGN', color: 0xef4444 },
    { minScore: 14000, label: 'LEGEND', color: 0xd946ef },
  ],
  // A siege pays for rooms and captures only, on a 40-second command clock,
  // and eighteen pieces is a short run — so the ladder is the shortest of the
  // four. Placeholder numbers by design: what a good siege score looks like is
  // one of the things the playtest is for.
  siege: [
    { minScore: 0, label: 'LEVY', color: 0x3b82f6 },
    { minScore: 500, label: 'SERJEANT', color: 0x10b981 },
    { minScore: 1400, label: 'CASTELLAN', color: 0xfbbf24 },
    { minScore: 3000, label: 'MARSHAL', color: 0xf59e0b },
    { minScore: 6000, label: 'WARDEN', color: 0xef4444 },
    { minScore: 12000, label: 'LEGEND', color: 0xd946ef },
  ],
};

export interface ProgressStatus {
  tiers: ProgressTier[];
  tierIndex: number;
  current: ProgressTier;
  next: ProgressTier | null;
  progressToNext: number;
}

export function getProgressStatus(difficulty: Difficulty, score: number): ProgressStatus {
  const tiers = PROGRESS_TIERS[difficulty];
  let tierIndex = 0;
  for (let i = 0; i < tiers.length; i++) {
    if (score >= tiers[i].minScore) tierIndex = i;
    else break;
  }
  const current = tiers[tierIndex];
  const next = tierIndex < tiers.length - 1 ? tiers[tierIndex + 1] : null;
  const progressToNext = next
    ? Math.max(0, Math.min((score - current.minScore) / Math.max(next.minScore - current.minScore, 1), 1))
    : 1;
  return { tiers, tierIndex, current, next, progressToNext };
}
