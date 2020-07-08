import { toEnum } from './utils'

export const GAME_STATE = toEnum([
  'GAME_INIT',
  'CREATE_HINTS',
  'RED_REVEAL',
  'BLUE_REVEAL',
  'ROUND_END',
  'TIE_BREAK',
  'GAME_END'
])
