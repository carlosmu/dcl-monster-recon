import { Storage } from '@dcl/sdk/server'

// Weekly Rewards: visit the scene on WEEKLY_REQUIRED_DAYS different UTC calendar days of the same
// week, completing at least one level each day, then claim once. The week is the same one the
// leaderboard uses (weekIdFor in server.ts, Monday 10:00 UTC reset) - it's passed in rather than
// recomputed here so both features always agree on which week it is.
export const WEEKLY_REQUIRED_DAYS = 2

// Player storage, one key per week, so past weeks stay archived and a new week starts empty.
const WEEKLY_REWARDS_KEY_PREFIX = 'weeklyRewards-'
// Scene storage, one key per week, next to leaderboard-<weekId> and with the same weekId: every
// player who claimed that week. This is the payout report - credits are handed out manually to
// everyone listed, so the amount never has to live in the scene. It's a mirror of the claimed
// player records above, which stay the authoritative copy for validating progress and claims.
const WEEKLY_REPORT_KEY_PREFIX = 'weekly-rewards-'

export interface WeeklyRewardsRecord {
  playerId: string
  weekId: string
  completedDays: string[] // unique UTC dates (YYYY-MM-DD)
  progress: number // completedDays.length capped at WEEKLY_REQUIRED_DAYS
  claimed: boolean
  claimedAt?: number
  createdAt: number
  updatedAt: number
}

interface WeeklyReportEntry {
  playerName: string // as reported by the client on claim - informational only, the key is what's paid
  completedDays: string[]
  daysCompleted: number
  claimedAt: string // ISO timestamp
}

interface WeeklyReport {
  weekId: string
  players: Record<string, WeeklyReportEntry> // keyed by wallet address
}

export type ClaimResult = { success: boolean; claimed: boolean; message: string }

// Cached by PROMISE, same reasoning as server.ts's progressCache: a level completion and a claim
// arriving back to back for the same player mutate one shared object instead of each reading,
// modifying and saving its own copy and clobbering the other's write.
const recordCache = new Map<string, Promise<WeeklyRewardsRecord>>()
const reportCache = new Map<string, Promise<WeeklyReport>>()
// Weeks whose last report write failed, so the next update rewrites it even if nothing changed.
const unsavedReports = new Set<string>()

export function dayIdFor(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function getWeeklyRecord(address: string, weekId: string): Promise<WeeklyRewardsRecord> {
  const cacheKey = `${address}|${weekId}`
  let record = recordCache.get(cacheKey)
  if (!record) {
    record = (async () => {
      const stored = await Storage.player.get<WeeklyRewardsRecord>(address, WEEKLY_REWARDS_KEY_PREFIX + weekId)
      if (stored) {
        // Re-mirror claims on the first read of each run, which heals any report write that failed before.
        void updateReport(stored)
        return stored
      }
      const now = Date.now()
      return { playerId: address, weekId, completedDays: [], progress: 0, claimed: false, createdAt: now, updatedAt: now }
    })()
    // A failed read must not stick around, or every later call would reuse the rejection.
    record.catch(() => recordCache.delete(cacheKey))
    recordCache.set(cacheKey, record)
  }
  return record
}

// Called when the player completes a level. Several levels on the same day still count once.
export async function registerLevelComplete(address: string, weekId: string, dayId: string): Promise<WeeklyRewardsRecord> {
  const record = await getWeeklyRecord(address, weekId)
  if (record.completedDays.includes(dayId)) return record
  record.completedDays.push(dayId)
  record.progress = Math.min(record.completedDays.length, WEEKLY_REQUIRED_DAYS)
  record.updatedAt = Date.now()
  await Storage.player.set(address, WEEKLY_REWARDS_KEY_PREFIX + weekId, record)
  return record
}

export async function claimWeeklyReward(address: string, playerName: string, weekId: string): Promise<ClaimResult> {
  const record = await getWeeklyRecord(address, weekId)
  if (record.claimed) return { success: false, claimed: true, message: 'Reward already claimed this week.' }
  if (record.progress < WEEKLY_REQUIRED_DAYS) {
    return { success: false, claimed: false, message: 'You must complete the weekly mission first.' }
  }
  // Flipped before any await, so a second claim racing this one sees claimed === true and is rejected.
  const now = Date.now()
  record.claimed = true
  record.claimedAt = now
  record.updatedAt = now
  // Storage.set reports failure by resolving false, not by throwing.
  if (!(await Storage.player.set(address, WEEKLY_REWARDS_KEY_PREFIX + weekId, record))) {
    // Not saved, so not claimed: undo it so the player can simply retry.
    record.claimed = false
    delete record.claimedAt
    console.error(`[Server] Weekly reward claim save failed for ${address} (week ${weekId})`)
    return { success: false, claimed: false, message: 'Could not save your claim. Please try again.' }
  }
  await updateReport(record, playerName)
  console.log(`[Server] Weekly reward claimed by ${playerName} (${address}) for week ${weekId}`)
  return {
    success: true,
    claimed: true,
    message: "We've registered your valid claim. You'll receive your credits over the course of next week."
  }
}

function getWeeklyReport(weekId: string): Promise<WeeklyReport> {
  let report = reportCache.get(weekId)
  if (!report) {
    // A failed read rejects (and is evicted) rather than falling back to an empty report, which
    // would then overwrite everyone already recorded this week.
    report = (async () => (await Storage.get<WeeklyReport>(WEEKLY_REPORT_KEY_PREFIX + weekId)) ?? { weekId, players: {} })()
    report.catch(() => reportCache.delete(weekId))
    reportCache.set(weekId, report)
  }
  return report
}

// Mirrors one claimed player's record into their week's report. Never throws - the player record already
// holds the truth, and since every write saves the whole report, a failed one is retried by the
// next update (or by this player's next visit, see getWeeklyRecord). Concurrent updates all mutate
// the one cached report object, and Storage.set commits writes to a key in issue order, so the
// last write always carries every player.
async function updateReport(record: WeeklyRewardsRecord, playerName?: string): Promise<void> {
  const { playerId: address, weekId } = record
  if (!record.claimed || record.claimedAt === undefined) return
  try {
    const report = await getWeeklyReport(weekId)
    const previous = report.players[address]
    const entry: WeeklyReportEntry = {
      playerName: playerName ?? previous?.playerName ?? '',
      completedDays: [...record.completedDays],
      daysCompleted: record.completedDays.length,
      claimedAt: new Date(record.claimedAt).toISOString()
    }
    if (!unsavedReports.has(weekId) && JSON.stringify(entry) === JSON.stringify(previous)) return
    report.players[address] = entry
    if (await Storage.set(WEEKLY_REPORT_KEY_PREFIX + weekId, report)) {
      unsavedReports.delete(weekId)
      return
    }
    unsavedReports.add(weekId)
    console.error(`[Server] Weekly rewards report write failed for week ${weekId}`)
  } catch (error) {
    // Only the report read can throw here (a failed set resolves false).
    console.error(`[Server] Weekly rewards report update failed for week ${weekId}`, error)
  }
}
