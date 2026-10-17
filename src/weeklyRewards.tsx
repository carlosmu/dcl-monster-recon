import ReactEcs, { UiEntity, UiBackgroundProps } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { timers } from '@dcl-sdk/utils'
import { room } from './shared/messages'
import { guard } from './errorTrap'
import { BitmapText, GERM_ONE_FONT, GERM_ONE_IMAGE, GERM_ONE_IMAGE_BROWN } from './bitmapFont'
import { DEBUG_FORCE_WEEKLY_REWARDS_HINTS } from './debugFlags'

// Weekly Rewards MVP: codex frame + bitmap font, solid-color buttons. All validation
// lives on the server (src/server/weeklyRewards.ts) - this side only shows what the server says.

type WeeklyRewardsState = 'loading' | 'ready' | 'claimable' | 'claimed' | 'error'

// No answer in this long -> 'error' while loading, or a retry message while claiming (server down /
// room never connected).
const LOAD_TIMEOUT_MS = 10000

let state: WeeklyRewardsState = 'loading'
let panelOpen = false
let progress = 0
let completedDays: string[] = []
let elapsedTime = 0
let requiredDays = 2
let claiming = false
let message: string | null = null
let loadTimeout: number | null = null

// 3:1, same as the atlas_02 F7:H7 art.
const CLAIM_BUTTON_WIDTH_PX = 240
const CLAIM_BUTTON_HEIGHT_PX = 80
const PROGRESS_BAR_BG_COLOR = Color4.create(0.25, 0.25, 0.25, 1)
// Entry button width:height - 65% of the width of the atlas_02 E1:H1 art (4:1). Its height and top inset come from
// the HUD (props.hudHeight / props.hudTop) so it lines up with the score box and header icons.
const ENTRY_BUTTON_ASPECT = 4 * 0.65
// Icon-to-box ratio of the HUD's own stat icons (STAT_ICON_SIZE_PX 60 in a 90px box).
const ENTRY_ICON_SCALE = 2 / 3
// Half the Play button's spinner oversize (PLAY_SPINNER_SCALE = 2 in ui.tsx).
const ENTRY_SPINNER_SCALE = 1
// Glow overlay on the entry button: opacity 0 -> 100% over the first half, back to 0 over the second.
const ENTRY_GLOW_PERIOD = 4 // seconds
// "!" badge over the entry button's right edge, vertically centered, sticking out by a third of its size.
const ENTRY_BADGE_SIZE_PX = 40

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

export function isWeeklyRewardsPanelOpen(): boolean {
  return panelOpen
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
    completedDays = data.completedDays
    requiredDays = data.requiredDays
    state = data.claimed ? 'claimed' : data.progress >= data.requiredDays ? 'claimable' : 'ready'
  }))
  room.onMessage('weeklyRewardClaimResult', (data) => guard('weeklyRewardClaimResult', () => {
    claiming = false
    message = data.message
    if (data.claimed) state = 'claimed'
  }))
  engine.addSystem((dt: number) => {
    elapsedTime += dt
  })
  requestStatus()
}

// Same day key as the server's dayIdFor (UTC date), so "today" matches what the server counts.
function hasCompletedLevelToday(): boolean {
  return completedDays.includes(new Date().toISOString().slice(0, 10))
}

// The glow nudges the player to come back and complete a level today - pointless before the status
// has loaded, or once the week's mission is already done.
function showingEntryGlow(): boolean {
  if (DEBUG_FORCE_WEEKLY_REWARDS_HINTS) return true
  return state === 'ready' && !hasCompletedLevelToday()
}

function getEntryGlowOpacity(): number {
  const t = (elapsedTime % ENTRY_GLOW_PERIOD) / (ENTRY_GLOW_PERIOD / 2) // 0..2
  return t < 1 ? t : 2 - t
}

function getProgressText(): string {
  if (state === 'loading') return 'Loading...'
  if (state === 'error') return 'Could not load weekly rewards. Try again later.'
  return `Progress: ${progress}/${requiredDays} days`
}

const Button = (props: {
  label: string
  background: UiBackgroundProps
  onPress: () => void
  width?: number
  height?: number
  icon?: UiBackgroundProps
  iconSize?: number
  overlay?: UiBackgroundProps
}) => (
  <UiEntity
    uiTransform={{ width: props.width ?? 220, height: props.height ?? 56, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }}
    uiBackground={props.background}
    onMouseDown={props.onPress}
  >
    {/* Drawn first so it sits over the background but under the icon/label. */}
    {props.overlay && (
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%' }}
        uiBackground={props.overlay}
      />
    )}
    {props.icon && (
      <UiEntity
        uiTransform={{ width: props.iconSize ?? 40, height: props.iconSize ?? 40, flexShrink: 0, margin: { right: 8 } }}
        uiBackground={props.icon}
      />
    )}
    <BitmapText text={props.label} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE} fontSize={24} />
  </UiEntity>
)

// The panel reuses the Monster Codex frame and close button. Their textures/UVs live in ui.tsx and
// are passed in rather than imported, since ui.tsx already imports this module.
export type WeeklyRewardsUiProps = {
  frameBackground: UiBackgroundProps
  framePadding: number
  closeButtonBackground: UiBackgroundProps
  closeButtonSize: number
  calendarIconBackground: UiBackgroundProps
  entryButtonBackground: UiBackgroundProps
  entryButtonIcon: UiBackgroundProps
  entryButtonGlow: UiBackgroundProps
  entryButtonBadge: UiBackgroundProps
  claimButtonBackground: UiBackgroundProps
  hudTop: number
  hudHeight: number
  renderSpinner: (widthPx: number, heightPx: number) => ReactEcs.JSX.Element
}

export const WeeklyRewardsUi = (props: WeeklyRewardsUiProps) => (
  <UiEntity
    uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
  >
    {/* Top-right entry button. */}
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: props.hudTop, right: 24 },
        width: props.hudHeight * ENTRY_BUTTON_ASPECT,
        height: props.hudHeight,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {/* Spinner behind the button until this week's mission is completed (2/2 days) - rendered
      first as an oversized flex child so it overflows symmetrically, same as the Play button's. */}
      {state !== 'claimable' &&
        state !== 'claimed' &&
        props.renderSpinner(props.hudHeight * ENTRY_BUTTON_ASPECT * ENTRY_SPINNER_SCALE, props.hudHeight * ENTRY_SPINNER_SCALE)}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 } }}>
        <Button
          label={'Weekly\nRewards'}
          background={props.entryButtonBackground}
          width={props.hudHeight * ENTRY_BUTTON_ASPECT}
          height={props.hudHeight}
          icon={props.entryButtonIcon}
          iconSize={props.hudHeight * ENTRY_ICON_SCALE}
          overlay={
            showingEntryGlow() ? { ...props.entryButtonGlow, color: Color4.create(1, 1, 1, getEntryGlowOpacity()) } : undefined
          }
          onPress={() => (panelOpen ? closePanel() : openPanel())}
        />
      </UiEntity>
      {/* Last sibling so it draws over the button - same condition as the glow. */}
      {showingEntryGlow() && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: (props.hudHeight - ENTRY_BADGE_SIZE_PX) / 2, right: -ENTRY_BADGE_SIZE_PX / 3 },
            width: ENTRY_BADGE_SIZE_PX,
            height: ENTRY_BADGE_SIZE_PX
          }}
          uiBackground={props.entryButtonBadge}
        />
      )}
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
          <BitmapText text="Weekly Rewards" font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={40} />
          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 16 } }}>
            <UiEntity
              uiTransform={{ width: 96, height: 96, flexShrink: 0, margin: { right: 16 } }}
              uiBackground={props.calendarIconBackground}
            />
            <BitmapText
              text={'Visit Monster Recon on 2 different days this week.\nComplete at least 1 level each day to count your visit.'}
              fontSize={22}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              maxWidth={480}
            />
          </UiEntity>
          <BitmapText text={getProgressText()} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={26} uiTransform={{ margin: { top: 24 } }} />
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
            <BitmapText
              text={message}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              fontSize={22}
              maxWidth={600}
              align="center"
              uiTransform={{ margin: { top: 16 } }}
            />
          )}
          <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 24 } }}>
            {/* Always pressable once loaded - the server answers with why a claim isn't allowed yet. */}
            <Button
              label={claiming ? 'Claiming...' : state === 'claimed' ? 'Claimed' : 'Claim Reward'}
              background={props.claimButtonBackground}
              width={CLAIM_BUTTON_WIDTH_PX}
              height={CLAIM_BUTTON_HEIGHT_PX}
              onPress={claim}
            />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    )}
  </UiEntity>
)
