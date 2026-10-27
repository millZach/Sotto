import type { WatcherScene } from '../../../shared/watcherScene'
import { DESERT } from './placeDesert'
import { HARBOUR } from './placeHarbour'
import { NIGHT_WOOD } from './placeNightWood'
import { SNOWFIELD } from './placeSnowfield'
import type { ScenePlace } from './scenePlace'

/** Every place Watcher's night scene can be set in, by its setting's id (ADR-0149). */
export const SCENE_PLACES: Record<WatcherScene, ScenePlace> = {
  'night-wood': NIGHT_WOOD,
  harbour: HARBOUR,
  snowfield: SNOWFIELD,
  desert: DESERT,
}
