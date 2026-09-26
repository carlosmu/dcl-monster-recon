import { createCritterRain } from './critterRain'

// Spider rain: see critterRain.tsx. Upward walkers are mirrored in Y so they face the way they move.
export const SpiderRain = createCritterRain({
  image: 'assets/images/spider.png',
  grid: 4,
  fps: 16,
  sizePx: 192,
  speedMinPx: 150,
  speedMaxPx: 250,
  spawnIntervalMinS: 0.4,
  spawnIntervalMaxS: 1.2,
  despawnMarginPx: 100,
  upwardChance: 0.5,
  turnChance: 0.3,
  turnAtMin: 0.15,
  turnAtMax: 0.85,
  mirrorWhenUpward: true,
  debugLabel: 'spiders',
  debugLabelTopPx: 16
})
