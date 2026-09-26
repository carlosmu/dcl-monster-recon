import { createCritterRain } from './critterRain'

// Bat rain: see critterRain.tsx. Same as the spiders, but always drawn the same way up (no Y mirror).
export const BatRain = createCritterRain({
  image: 'assets/images/bat.png',
  grid: 4,
  fps: 16,
  sizePx: 192,
  speedMinPx: 75,
  speedMaxPx: 125,
  spawnIntervalMinS: 0.4,
  spawnIntervalMaxS: 1.2,
  despawnMarginPx: 100,
  upwardChance: 0.5,
  turnChance: 0.3,
  turnAtMin: 0.15,
  turnAtMax: 0.85,
  mirrorWhenUpward: false,
  debugLabel: 'bats',
  debugLabelTopPx: 56
})
