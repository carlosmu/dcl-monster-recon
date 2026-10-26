# Monster Recon — promo brief

*Created by promote-scene on 2026-10-23 for the marketing kit. Not a GDD: `dcl-gdd` can harvest it
into `design/gdd.md` later. "Creator:" = the creator's words in this session. "Repo:" = read from the
project and confirmed by the creator. "Repo, unconfirmed:" = read from the project, not yet confirmed.*

## Promise
Repo, unconfirmed: "Race against the clock in fast Memory Match rounds, then dash through camp to hunt down your monsters." (`scene.json` description)

## Who and how long
Repo, unconfirmed: solo play with a shared weekly leaderboard (authoritative server); "compare discoveries with friends" (`scene.json`). 20 checkpoints, one monster each. Visit length not stated anywhere.

## Signature moments
1. Memory Match board on a timer, "MATCH!" popup, timer blinks red under 10 s (Repo: `src/ui.tsx`, `src/checkpoints.json`)
2. The chase: the won monster hops between spots in camp, 5 chances, 12 s per hop early down to 3 s from level 19 (Repo: `src/prizeChase.ts`)
3. "Monster Collected!" and the Monster Codex filling up: 8 Common, 6 Rare, 4 Exotic, 2 Epic (Repo: `src/ui.tsx`)
4. Weekly leaderboard and weekly rewards, reset every Monday 10:00 UTC (Repo: `src/server/server.ts`, `src/weeklyRewards.tsx`)
5. Halloween Edition: spiders and bats, Halloween music and stingers (Repo: `src/critterRain.tsx`, `assets/audio/*_halloween.mp3`, thumbnail)

## Audience and comparables
Not asked. Comparables: none. May be named in posts: no (default).

## Keep secret
Agent default, not confirmed by the creator: the two Epic monsters are shown only as locked silhouettes.

## Name, handles, status
- Title IP: not checked.
- Handles: not given, `@yourhandle` placeholder.
- Status: published at `monsterrecon.dcl.eth` (deployed link card checked 2026-10-23).
- Weekly rewards: Creator: may be mentioned generically (no amounts, no "credits" promise).
- Recurring events (UTC): weekly leaderboard reset, Monday 10:00 UTC.
- Post language: Creator: English.

## Harvested from the repo
- 20 monster names, verbatim (`src/ui.tsx` `MONSTER_NAMES`)
- First board 20 s; checkpoint 2's first board 13 s (`src/checkpoints.json`)
- Weekly mission = finish a level on 2 different days of the week (`src/server/weeklyRewards.ts`); kept out of copy per "generic"
- Credits: Board Music by Bensound (B. Tissot), already in the scene description
