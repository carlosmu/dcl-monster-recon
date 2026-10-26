import ReactEcs, { UiEntity, UiBackgroundProps, Label } from '@dcl/sdk/react-ecs'
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
let claimOrder = 0
let earlySlots = 20
let claiming = false
let message: string | null = null
// Errors (e.g. claiming before the mission is complete) show in red instead of the usual brown.
let messageIsError = false
let loadTimeout: number | null = null

// 3:1, same as the atlas_02 F7:H7 art.
const CLAIM_BUTTON_WIDTH_PX = 240
const CLAIM_BUTTON_HEIGHT_PX = 80
const EARLY_REWARD_CREDITS = 5
const CHAMPION_CREDITS = 50
const LUCKY_PLAYER_CREDITS = 50
// Descriptions use the default (readable) font; the medieval bitmap font is kept for headings.
// Same text color as the leaderboard's reset note (SCREEN_TEXT_COLOR in ui.tsx).
const TEXT_COLOR = Color4.fromHexString('#2c180b')
const DESCRIPTION_FONT_SIZE_PX = 22
// The mission line is the panel's main instruction, so it reads a step above the other descriptions.
const MISSION_FONT_SIZE_PX = 28
const FOOTER_FONT_SIZE_PX = 18
// Credit amounts: "50 <credits icon>" in white on a purple badge. Fixed width, so every amount
// (5, 50, ...) gets the same badge regardless of digit count.
const CREDITS_COLOR = Color4.White()
const CREDITS_BADGE_COLOR = Color4.fromHexString('#571B87')
const CREDITS_BADGE_WIDTH_PX = 84
const CREDITS_BADGE_HEIGHT_PX = 36
const CREDITS_BADGE_RADIUS_PX = 10
const CREDITS_ICON_SIZE_PX = 24
// Section heading ("Credit Rewards"): same readable font as the descriptions, set
// apart by size rather than bold, since rich-text tags aren't guaranteed on every runtime.
const SECTION_HEADING_FONT_SIZE_PX = 30
// Box holding the "Rewards" heading and its rows: a faint white wash over the parchment, framed in
// the panel's wood brown.
const REWARD_BOX_COLOR = Color4.create(1, 1, 1, 0.05)
const REWARD_BOX_RADIUS_PX = 12
const REWARD_BOX_PADDING_PX = 12
const REWARD_BOX_BORDER_PX = 3
const REWARD_BOX_BORDER_COLOR = Color4.create(0.33, 0.18, 0.08, 1)
// Replaces the day checkboxes when the status couldn't load: white text on a red pill.
const OFFLINE_BADGE_COLOR = Color4.fromHexString('#b3261e')
const OFFLINE_BADGE_RADIUS_PX = 6
const OFFLINE_BADGE_FONT_SIZE_PX = 16
const CALENDAR_ICON_SIZE_PX = 128
const CHECKBOX_SIZE_PX = 40
const REWARD_ICON_SIZE_PX = 48
const REWARD_ROWS_WIDTH_PX = 440
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

// Exported so ui.tsx can close the panel when the Leaderboard or Monster Codex opens.
export function closePanel() {
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
    claimOrder = data.claimOrder
    earlySlots = data.earlySlots
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

// claimOrder 0 = claimed before claim positions were tracked, so there's no position to show.
function getClaimedText(): string {
  if (claimOrder > 0 && claimOrder <= earlySlots) {
    return `You're #${claimOrder}! You'll receive your ${EARLY_REWARD_CREDITS} credits over the course of next week, and you're in the Lucky Player raffle.`
  }
  if (claimOrder > earlySlots) {
    return `The first ${earlySlots} spots are taken, but you're in the Lucky Player raffle! Winners receive their credits over the course of next week.`
  }
  return "You're in the Lucky Player raffle! Credits are paid out over the course of next week."
}

// Display only - the checkboxes mirror the server's progress and can't be toggled.
const DayCheckbox = (props: { day: number; checked: boolean; on: UiBackgroundProps; off: UiBackgroundProps }) => (
  <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { right: 24 } }}>
    <UiEntity
      uiTransform={{ width: CHECKBOX_SIZE_PX, height: CHECKBOX_SIZE_PX, flexShrink: 0, margin: { right: 8 } }}
      uiBackground={props.checked ? props.on : props.off}
    />
    <Label value={`Day ${props.day}`} fontSize={DESCRIPTION_FONT_SIZE_PX} color={TEXT_COLOR} textAlign="middle-left" />
  </UiEntity>
)

// Amounts are display copy only - credits are paid out manually from the server's weekly report.
const RewardRow = (props: { icon: UiBackgroundProps; label: string; credits: number; creditsIcon: UiBackgroundProps }) => (
  <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { top: 6 } }}>
    <UiEntity
      uiTransform={{ width: REWARD_ICON_SIZE_PX, height: REWARD_ICON_SIZE_PX, flexShrink: 0, margin: { right: 12 } }}
      uiBackground={props.icon}
    />
    <Label value={props.label} fontSize={DESCRIPTION_FONT_SIZE_PX} color={TEXT_COLOR} textAlign="middle-left" uiTransform={{ flexGrow: 1 }} />
    <UiEntity
      uiTransform={{
        width: CREDITS_BADGE_WIDTH_PX,
        height: CREDITS_BADGE_HEIGHT_PX,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        // Right-aligned, so the credits icons line up across rows whatever the digit count.
        justifyContent: 'flex-end',
        padding: { right: 10 },
        borderRadius: CREDITS_BADGE_RADIUS_PX
      }}
      uiBackground={{ color: CREDITS_BADGE_COLOR }}
    >
      <Label value={`${props.credits}`} fontSize={DESCRIPTION_FONT_SIZE_PX} color={CREDITS_COLOR} textAlign="middle-center" />
      <UiEntity
        uiTransform={{ width: CREDITS_ICON_SIZE_PX, height: CREDITS_ICON_SIZE_PX, flexShrink: 0, margin: { left: 4 } }}
        uiBackground={props.creditsIcon}
      />
    </UiEntity>
  </UiEntity>
)

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
  earlyRewardIconBackground: UiBackgroundProps
  championIconBackground: UiBackgroundProps
  luckyPlayerIconBackground: UiBackgroundProps
  creditsIconBackground: UiBackgroundProps
  checkboxOnBackground: UiBackgroundProps
  checkboxOffBackground: UiBackgroundProps
  entryButtonBackground: UiBackgroundProps
  entryButtonIcon: UiBackgroundProps
  entryButtonGlow: UiBackgroundProps
  entryButtonBadge: UiBackgroundProps
  claimButtonBackground: UiBackgroundProps
  hudTop: number
  hudHeight: number
  renderSpinner: (widthPx: number, heightPx: number) => ReactEcs.JSX.Element
  // Called right before the entry button opens the panel, so ui.tsx can close the Leaderboard or
  // Monster Codex - only one of them is ever up at a time.
  onOpen: () => void
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
          onPress={() => {
            if (panelOpen) return closePanel()
            props.onOpen()
            openPanel()
          }}
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
  </UiEntity>
)

// The panel itself. ui.tsx renders it in canvas_main's body, the same slot as the Leaderboard and
// Monster Codex screens, with their sizing (full width, 80-100% of the body's height).
export const WeeklyRewardsPanel = (props: WeeklyRewardsUiProps) => (
  <UiEntity
    uiTransform={{
      width: '100%',
      height: 'auto',
      minHeight: '80%',
      maxHeight: '100%',
      flexDirection: 'column',
      alignItems: 'center',
      padding: props.framePadding
    }}
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
        uiTransform={{ width: CALENDAR_ICON_SIZE_PX, height: CALENDAR_ICON_SIZE_PX, flexShrink: 0, margin: { right: 16 } }}
        uiBackground={props.calendarIconBackground}
      />
      <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <Label
          value="Complete 1 level on 2 different days."
          fontSize={MISSION_FONT_SIZE_PX}
          color={TEXT_COLOR}
          textAlign="middle-left"
        />
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 12 } }}>
          {state === 'loading' ? (
            <Label value="Loading..." fontSize={DESCRIPTION_FONT_SIZE_PX} color={TEXT_COLOR} textAlign="middle-left" />
          ) : state === 'error' ? (
            <UiEntity
              uiTransform={{ padding: { top: 2, bottom: 2, left: 8, right: 8 }, borderRadius: OFFLINE_BADGE_RADIUS_PX }}
              uiBackground={{ color: OFFLINE_BADGE_COLOR }}
            >
              <Label value="Server is offline" fontSize={OFFLINE_BADGE_FONT_SIZE_PX} color={Color4.White()} textAlign="middle-center" />
            </UiEntity>
          ) : (
            Array.from({ length: requiredDays }, (_, i) => (
              <DayCheckbox
                day={i + 1}
                checked={progress > i}
                on={props.checkboxOnBackground}
                off={props.checkboxOffBackground}
              />
            ))
          )}
        </UiEntity>
      </UiEntity>
    </UiEntity>
    <UiEntity
      uiTransform={{
        width: REWARD_ROWS_WIDTH_PX,
        flexDirection: 'column',
        alignItems: 'flex-start',
        margin: { top: 20 },
        padding: REWARD_BOX_PADDING_PX,
        borderRadius: REWARD_BOX_RADIUS_PX,
        borderWidth: REWARD_BOX_BORDER_PX,
        borderColor: REWARD_BOX_BORDER_COLOR
      }}
      uiBackground={{ color: REWARD_BOX_COLOR }}
    >
      <Label value="Credit Rewards" fontSize={SECTION_HEADING_FONT_SIZE_PX} color={TEXT_COLOR} textAlign="middle-left" />
      <RewardRow icon={props.earlyRewardIconBackground} label={`First ${earlySlots} Players`} credits={EARLY_REWARD_CREDITS} creditsIcon={props.creditsIconBackground} />
      <RewardRow icon={props.championIconBackground} label="Weekly Champion" credits={CHAMPION_CREDITS} creditsIcon={props.creditsIconBackground} />
      <RewardRow icon={props.luckyPlayerIconBackground} label="Lucky Player" credits={LUCKY_PLAYER_CREDITS} creditsIcon={props.creditsIconBackground} />
    </UiEntity>
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
        // Already claimed this week: nothing left to press, so the button gives way to what the
        // player earned (credits are paid out manually from the weekly-rewards report).
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <BitmapText
            text="Claimed!"
            font={GERM_ONE_FONT}
            image={GERM_ONE_IMAGE_BROWN}
            fontSize={40}
            uiTransform={{ margin: { top: 8, bottom: 16 } }}
          />
          <Label
            value={getClaimedText()}
            fontSize={DESCRIPTION_FONT_SIZE_PX}
            color={TEXT_COLOR}
            textAlign="middle-center"
            textWrap="wrap"
            uiTransform={{ width: 600 }}
          />
        </UiEntity>
      ) : (
        // Always pressable once loaded - the server answers with why a claim isn't allowed yet.
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <Button
            label={claiming ? 'Claiming...' : 'Claim Reward'}
            background={props.claimButtonBackground}
            width={CLAIM_BUTTON_WIDTH_PX}
            height={CLAIM_BUTTON_HEIGHT_PX}
            onPress={claim}
          />
          <Label
            value="Resets Monday · 10:00 UTC"
            fontSize={FOOTER_FONT_SIZE_PX}
            color={TEXT_COLOR}
            textAlign="middle-center"
            uiTransform={{ margin: { top: 12 } }}
          />
        </UiEntity>
      )}
    </UiEntity>
  </UiEntity>
)
