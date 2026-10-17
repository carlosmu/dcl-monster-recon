import ReactEcs, { UiEntity, Label, UiBackgroundProps } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { timers } from '@dcl-sdk/utils'
import { room } from './shared/messages'
import { guard } from './errorTrap'

// Weekly Rewards MVP: placeholder box UI (solid panels + plain Labels, no art yet). All validation
// lives on the server (src/server/weeklyRewards.ts) - this side only shows what the server says.

type WeeklyRewardsState = 'loading' | 'ready' | 'claimable' | 'claimed' | 'error'

// No answer in this long -> 'error' while loading, or a retry message while claiming (server down /
// room never connected).
const LOAD_TIMEOUT_MS = 10000

let state: WeeklyRewardsState = 'loading'
let panelOpen = false
let progress = 0
let requiredDays = 2
let claiming = false
let message: string | null = null
let loadTimeout: number | null = null

const BUTTON_COLOR = Color4.create(0.25, 0.25, 0.3, 1)
const BUTTON_DISABLED_COLOR = Color4.create(0.18, 0.18, 0.2, 1)
const CLAIM_COLOR = Color4.create(0.15, 0.5, 0.2, 1)
const PROGRESS_BAR_BG_COLOR = Color4.create(0.25, 0.25, 0.25, 1)
const PROGRESS_BAR_FILL_COLOR = Color4.create(0.3, 0.75, 0.35, 1)

function requestStatus() {
  // Already-loaded states keep showing their last value while the refresh is in flight.
  if (state === 'error') state = 'loading'
  if (loadTimeout !== null) timers.clearTimeout(loadTimeout)
  loadTimeout = timers.setTimeout(() => {
    loadTimeout = null
    if (state === 'loading') state = 'error'
  }, LOAD_TIMEOUT_MS)
  room.send('requestWeeklyRewards', {})
}

function openPanel() {
  panelOpen = true
  message = null
  requestStatus()
}

function closePanel() {
  panelOpen = false
  message = null
}

function claim() {
  if (claiming || state === 'loading' || state === 'error') return
  claiming = true
  message = null
  timers.setTimeout(() => {
    if (!claiming) return
    claiming = false
    message = 'Could not reach the server. Try again.'
  }, LOAD_TIMEOUT_MS)
  room.send('claimWeeklyReward', { playerName: getPlayer()?.name ?? 'Unknown' })
}

export function setupWeeklyRewards() {
  room.onMessage('weeklyRewardsUpdate', (data) => guard('weeklyRewardsUpdate', () => {
    if (loadTimeout !== null) {
      timers.clearTimeout(loadTimeout)
      loadTimeout = null
    }
    progress = data.progress
    requiredDays = data.requiredDays
    state = data.claimed ? 'claimed' : data.progress >= data.requiredDays ? 'claimable' : 'ready'
  }))
  room.onMessage('weeklyRewardClaimResult', (data) => guard('weeklyRewardClaimResult', () => {
    claiming = false
    message = data.message
    if (data.claimed) state = 'claimed'
  }))
  requestStatus()
}

function getProgressText(): string {
  if (state === 'loading') return 'Loading...'
  if (state === 'error') return 'Could not load weekly rewards. Try again later.'
  return `Progress: ${progress}/${requiredDays} days`
}

const Button = (props: { label: string; color: Color4; onPress: () => void; width?: number }) => (
  <UiEntity
    uiTransform={{ width: props.width ?? 220, height: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}
    uiBackground={{ color: props.color }}
    onMouseDown={props.onPress}
  >
    <Label value={props.label} fontSize={24} color={Color4.White()} />
  </UiEntity>
)

// The panel reuses the Monster Codex frame and close button. Their textures/UVs live in ui.tsx and
// are passed in rather than imported, since ui.tsx already imports this module.
export type WeeklyRewardsUiProps = {
  frameBackground: UiBackgroundProps
  framePadding: number
  closeButtonBackground: UiBackgroundProps
  closeButtonSize: number
  textColor: Color4
}

export const WeeklyRewardsUi = (props: WeeklyRewardsUiProps) => (
  <UiEntity
    uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
  >
    {/* Top-right entry button. */}
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 24, right: 24 } }}>
      <Button label="Weekly Rewards" color={BUTTON_COLOR} width={240} onPress={() => (panelOpen ? closePanel() : openPanel())} />
    </UiEntity>

    {panelOpen && (
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          position: { top: 0, left: 0 },
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <UiEntity
          uiTransform={{ width: 720, flexDirection: 'column', alignItems: 'center', padding: props.framePadding }}
          uiBackground={props.frameBackground}
        >
          <UiEntity
            uiTransform={{
              width: props.closeButtonSize,
              height: props.closeButtonSize,
              positionType: 'absolute',
              position: { top: 8, right: 8 }
            }}
            uiBackground={props.closeButtonBackground}
            onMouseDown={closePanel}
          />
          <Label value="Weekly Rewards" fontSize={40} color={props.textColor} />
          <Label
            value={'Visit Monster Recon on 2 different days this week.\nComplete at least 1 level each day to count your visit.'}
            fontSize={22}
            color={props.textColor}
            textAlign="middle-center"
            uiTransform={{ margin: { top: 16 } }}
          />
          <Label value={getProgressText()} fontSize={26} color={props.textColor} uiTransform={{ margin: { top: 24 } }} />
          {state !== 'loading' && state !== 'error' && (
            <UiEntity
              uiTransform={{ width: 400, height: 16, margin: { top: 12 }, borderRadius: 8 }}
              uiBackground={{ color: PROGRESS_BAR_BG_COLOR }}
            >
              <UiEntity
                uiTransform={{ width: `${(Math.min(progress, requiredDays) / requiredDays) * 100}%`, height: '100%', borderRadius: 8 }}
                uiBackground={{ color: PROGRESS_BAR_FILL_COLOR }}
              />
            </UiEntity>
          )}
          {message !== null && (
            <Label value={message} fontSize={22} color={props.textColor} uiTransform={{ margin: { top: 16 } }} />
          )}
          <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 24 } }}>
            {/* Always pressable once loaded - the server answers with why a claim isn't allowed yet. */}
            <Button
              label={claiming ? 'Claiming...' : state === 'claimed' ? 'Claimed' : 'Claim Reward'}
              color={state === 'claimable' ? CLAIM_COLOR : BUTTON_DISABLED_COLOR}
              onPress={claim}
            />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    )}
  </UiEntity>
)
