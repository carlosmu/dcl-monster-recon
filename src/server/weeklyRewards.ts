import { Storage } from '@dcl/sdk/server'

// Weekly Rewards: visit the scene on WEEKLY_REQUIRED_DAYS different UTC calendar days of the same
// week, completing at least one level each day, then claim once. The week is the same one the
// leaderboard uses (weekIdFor in server.ts, Monday 10:00 UTC reset) - it's passed in rather than
// recomputed here so both features always agree on which week it is.
export const WEEKLY_REQUIRED_DAYS = 2

// Player storage, one key per week, so past weeks stay archived and a new week starts empty.
const WEEKLY_REWARDS_KEY_PREFIX = 'weeklyRewards-'
// Scene storage, one key per week: everyone who claimed that week. This is the reward delivery
// ledger - the credits payout reads from here, so the amount never has to live in the scene.
const WEEKLY_CLAIMS_KEY_PREFIX = 'weekly-reward-claims-'

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

type WeeklyClaims = Record<string, { playerName: string; claimedAt: number }> // keyed by wallet address

export type ClaimResult = { success: boolean; claimed: boolean; message: string }

// Cached by PROMISE, same reasoning as server.ts's progressCache: a level completion and a claim
// arriving back to back for the same player mutate one shared object instead of each reading,
// modifying and saving its own copy and clobbering the other's write.
const recordCache = new Map<string, Promise<WeeklyRewardsRecord>>()
const claimsCache = new Map<string, Promise<WeeklyClaims>>()

export function dayIdFor(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function getWeeklyRecord(address: string, weekId: string): Promise<WeeklyRewardsRecord> {
  const cacheKey = `${address}|${weekId}`
  let record = recordCache.get(cacheKey)
  if (!record) {
    record = (async () => {
      const stored = await Storage.player.get<WeeklyRewardsRecord>(address, WEEKLY_REWARDS_KEY_PREFIX + weekId)
      if (stored) return stored
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
  await Storage.player.set(address, WEEKLY_REWARDS_KEY_PREFIX + weekId, record)
  await registerRewardDelivery(address, playerName, weekId, now)
  console.log(`[Server] Weekly reward claimed by ${playerName} (${address}) for week ${weekId}`)
  return { success: true, claimed: true, message: 'Reward claimed successfully.' }
}

async function registerRewardDelivery(address: string, playerName: string, weekId: string, claimedAt: number): Promise<void> {
  let claims = claimsCache.get(weekId)
  if (!claims) {
    claims = (async () => (await Storage.get<WeeklyClaims>(WEEKLY_CLAIMS_KEY_PREFIX + weekId)) ?? {})()
    claims.catch(() => claimsCache.delete(weekId))
    claimsCache.set(weekId, claims)
  }
  const ledger = await claims
  ledger[address] = { playerName, claimedAt }
  await Storage.set(WEEKLY_CLAIMS_KEY_PREFIX + weekId, ledger)
}
