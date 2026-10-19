import ReactEcs, { UiEntity, UiBackgroundProps } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { timers } from '@dcl-sdk/utils'
import { room } from './shared/messages'
import { guard } from './errorTrap'
import { BitmapText, GERM_ONE_FONT, GERM_ONE_IMAGE, GERM_ONE_IMAGE_BROWN, GERM_ONE_IMAGE_RED } from './bitmapFont'
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
// Errors (e.g. claiming before the mission is complete) show in red instead of the usual brown.
let messageIsError = false
let loadTimeout: number | null = null

// 3:1, same as the atlas_02 F7:H7 art.
const CLAIM_BUTTON_WIDTH_PX = 240
const CLAIM_BUTTON_HEIGHT_PX = 80
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

// Progress bar: flat UI only (no textures). Wooden frame + warm dark track, and a fill whose
// greens match the Claim button art (atlas_02 F7:H7). There's no gradient support, so the fill's
// vertical gradient is faked by stacking rounded layers, darkest at the bottom.
const PROGRESS_BAR_WIDTH_PX = 400
const PROGRESS_BAR_HEIGHT_PX = 18
const PROGRESS_BAR_BORDER_PX = 2
const PROGRESS_BAR_INNER_RADIUS_PX = PROGRESS_BAR_HEIGHT_PX / 2 - PROGRESS_BAR_BORDER_PX
const PROGRESS_BAR_FRAME_COLOR = Color4.create(0.33, 0.18, 0.08, 1)
const PROGRESS_BAR_TRACK_COLOR = Color4.create(0.2, 0.11, 0.05, 1)
const PROGRESS_BAR_INNER_SHADOW_COLOR = Color4.create(0, 0, 0, 0.35)
const PROGRESS_BAR_FILL_DARK_COLOR = Color4.create(0.13, 0.42, 0.1, 1)
const PROGRESS_BAR_FILL_MID_COLOR = Color4.create(0.24, 0.6, 0.16, 1)
const PROGRESS_BAR_FILL_LIGHT_COLOR = Color4.create(0.42, 0.76, 0.28, 1)
const PROGRESS_BAR_HIGHLIGHT_COLOR = Color4.create(1, 1, 1, 0.3)

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

// Exported so ui.tsx can bring the panel back once the claim celebration ends.
export function openPanel() {
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
    messageIsError = true
  }, LOAD_TIMEOUT_MS)
  room.send('claimWeeklyReward', { playerName: getPlayer()?.name ?? 'Unknown' })
}

// onClaimed: fired once when the server confirms a successful claim (ui.tsx plays the celebration).
// The panel closes first so the celebration's centered icon and toast aren't hidden behind it.
export function setupWeeklyRewards(onClaimed: () => void) {
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
    messageIsError = !data.success && !data.claimed
    if (data.success) {
      closePanel()
      onClaimed()
    }
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
              uiTransform={{ width: 192, height: 192, flexShrink: 0, margin: { right: 16 } }}
              uiBackground={props.calendarIconBackground}
            />
            <BitmapText
              text={'Visit Monster Recon on 2 different days this week.\n\nComplete at least 1 level each day to count your visit.'}
              fontSize={22}
              font={GERM_ONE_FONT}
              image={GERM_ONE_IMAGE_BROWN}
              maxWidth={416}
            />
          </UiEntity>
          <BitmapText text={getProgressText()} font={GERM_ONE_FONT} image={GERM_ONE_IMAGE_BROWN} fontSize={26} uiTransform={{ margin: { top: 24 } }} />
          {state !== 'loading' && state !== 'error' && (
            <UiEntity
              uiTransform={{
                width: PROGRESS_BAR_WIDTH_PX,
                height: PROGRESS_BAR_HEIGHT_PX,
                margin: { top: 12 },
                borderRadius: PROGRESS_BAR_HEIGHT_PX / 2,
                borderWidth: PROGRESS_BAR_BORDER_PX,
                borderColor: PROGRESS_BAR_FRAME_COLOR
              }}
              uiBackground={{ color: PROGRESS_BAR_TRACK_COLOR }}
            >
              {/* Inner shadow along the track's top edge; the fill draws over it. */}
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: 4, borderRadius: PROGRESS_BAR_INNER_RADIUS_PX }}
                uiBackground={{ color: PROGRESS_BAR_INNER_SHADOW_COLOR }}
              />
              <UiEntity
                uiTransform={{ width: `${(Math.min(progress, requiredDays) / requiredDays) * 100}%`, height: '100%', borderRadius: PROGRESS_BAR_INNER_RADIUS_PX }}
                uiBackground={{ color: PROGRESS_BAR_FILL_DARK_COLOR }}
              >
                <UiEntity
                  uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '70%', borderRadius: PROGRESS_BAR_INNER_RADIUS_PX }}
                  uiBackground={{ color: PROGRESS_BAR_FILL_MID_COLOR }}
                />
                <UiEntity
                  uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '40%', borderRadius: PROGRESS_BAR_INNER_RADIUS_PX }}
                  uiBackground={{ color: PROGRESS_BAR_FILL_LIGHT_COLOR }}
                />
                {/* Glossy highlight, inset from the rounded ends. */}
                <UiEntity
                  uiTransform={{ positionType: 'absolute', position: { top: 2, left: 4, right: 4 }, height: 3, borderRadius: 2 }}
                  uiBackground={{ color: PROGRESS_BAR_HIGHLIGHT_COLOR }}
                />
              </UiEntity>
            </UiEntity>
          )}
          {message !== null && (
            <BitmapText
              text={message}
              font={GERM_ONE_FONT}
              image={messageIsError ? GERM_ONE_IMAGE_RED : GERM_ONE_IMAGE_BROWN}
              fontSize={22}
              maxWidth={600}
              align="center"
              uiTransform={{ margin: { top: 16 } }}
            />
          )}
          <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 24 } }}>
            {state === 'claimed' && !claiming ? (
              // Already claimed this week: nothing left to press, so the button gives way to when
              // the credits arrive (they're paid out manually from the weekly-rewards report).
              <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
                <BitmapText
                  text="Claimed!"
                  font={GERM_ONE_FONT}
                  image={GERM_ONE_IMAGE_BROWN}
                  fontSize={40}
                  uiTransform={{ margin: { top: 8, bottom: 16 } }}
                />
                <BitmapText
                  text="You'll receive your credits over the course of next week."
                  font={GERM_ONE_FONT}
                  image={GERM_ONE_IMAGE_BROWN}
                  fontSize={22}
                  maxWidth={600}
                  align="center"
                />
              </UiEntity>
            ) : (
              // Always pressable once loaded - the server answers with why a claim isn't allowed yet.
              <Button
                label={claiming ? 'Claiming...' : 'Claim Reward'}
                background={props.claimButtonBackground}
                width={CLAIM_BUTTON_WIDTH_PX}
                height={CLAIM_BUTTON_HEIGHT_PX}
                onPress={claim}
              />
            )}
          </UiEntity>
        </UiEntity>
      </UiEntity>
    )}
  </UiEntity>
)
