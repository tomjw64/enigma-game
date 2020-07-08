const { createMachine, interpret } = require('@xstate/fsm')
const { sampleSize } = require('lodash')
const natural = require('natural')

const { toEnum } = require('../shared/utils')
const { TEAM } = require('../shared/team')
const { GAME_STATE } = require('../shared/game-state')
const { GAME_ROLE } = require('../shared/game-role')

const TRANSITION = toEnum([
  'START_GAME',
  'START_ROUND',
  'END_ROUND',
  'NEXT_ROUND_STEP',
  'TIE_BREAK',
  'END_GAME',
])

const createGameStateMachine = (hooks) => {
  return createMachine({
    id: 'game-state-machine',
    initial: GAME_STATE.GAME_INIT,
    states: {
      [GAME_STATE.GAME_INIT]: {
        on: { [TRANSITION.START_ROUND]: GAME_STATE.CREATE_HINTS },
        entry: ['onGameInit'],
        exit: ['onGameStart']
      },
      [GAME_STATE.CREATE_HINTS]: {
        on: { [TRANSITION.NEXT_ROUND_STEP]: GAME_STATE.RED_REVEAL},
        entry: ['onRoundStart'],
        exit: ['onHintsCreated']
      },
      [GAME_STATE.RED_REVEAL]: {
        on: { [TRANSITION.NEXT_ROUND_STEP]: GAME_STATE.BLUE_REVEAL },
        entry: ['onRedReveal'],
        exit: ['onRedRevealGuesses']
      },
      [GAME_STATE.BLUE_REVEAL]: {
        on: { [TRANSITION.END_ROUND]: GAME_STATE.ROUND_END },
        entry: ['onBlueReveal'],
        exit: ['onBlueRevealGuesses']
      },
      [GAME_STATE.ROUND_END]: {
        on: {
          [TRANSITION.START_ROUND]: GAME_STATE.CREATE_HINTS,
          [TRANSITION.TIE_BREAK]: GAME_STATE.TIE_BREAK,
          [TRANSITION.END_GAME]: GAME_STATE.GAME_END
        },
        entry: ['onRoundEnd']
      },
      [GAME_STATE.TIE_BREAK]:{
        on: { [TRANSITION.END_GAME]: GAME_STATE.GAME_END },
        entry: ['onTieBreak'],
        exit: ['onTieBreakGuesses']
      },
      [GAME_STATE.GAME_END]: {
        on: { [TRANSITION.START_GAME]: GAME_STATE.GAME_INIT },
        entry: ['onGameEnd']
      },
    },
  }, { actions: hooks })
}

const createTeam = () => {
  return {
    caller: null, // string (socket id), public
    receivers: [], // Array<string (socket id)>, public
    hintHistory: [], // Array<activeHint>, public
    guessHistorySelf: [], // Array<activeGuess>, public
    guessHistoryOther: [], // Array<activeGuess>, public
    cardHistory: [], // Array<activeCard>, public
    crackedCount: 0, // int, public
    errorCount: 0, // int, public
    activeCard: null, // Array<int> of length 3, team (caller)
    targetWords: null, // Array<string> of length 4, team
    tieBreakGuess: null, // Array<string> of length 4, public?
    activeHint: null, // Array<string> of length 3, public?
    activeGuess: null, // Array<int> of length 3, team
  }
}

class Game {
  constructor(words, maxRounds) {
    this.words = words
    this.maxRounds = maxRounds
    const hooks = {
      'onGameInit': () => {
        this.teams = {
          [TEAM.BLUE]: createTeam(),
          [TEAM.RED]: createTeam(),
          [TEAM.SPECTATORS]: createTeam()
        }
      },
      'onGameStart': () => {
        // Populate the target words for teams
        const noDuplicateSample = sampleSize(words, 8)
        this.teams[TEAM.RED].targetWords = noDuplicateSample.slice(0,4)
        this.teams[TEAM.BLUE].targetWords = noDuplicateSample.slice(4)
      },
      'onRoundStart': () => {
        // Increment round counter
        this.roundCount += 1
        // Draw a new card for hint creation for target words
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeCard = sampleSize([1,2,3,4], 3)
          this.teams[team].activeHint = null
        }
      },
      'onHintsCreated': () => {
        // Make created hints publicly viewable
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].hintHistory.push(this.teams[team].activeHint)
        }
      },
      'onRedReveal': () => {
        // Clear team guesses - [1,1,1] by default since its technically a valid selection
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeGuess = [1, 1, 1]
        }
      },
      'onRedRevealGuesses': () => {
        // Make guesses public and check correctness
        if (this.teams[TEAM.BLUE].activeGuess === this.teams[TEAM.RED].activeCard) {
          this.teams[TEAM.BLUE].crackedCount += 1
        }
        if (this.teams[TEAM.RED].activeGuess !== this.teams[TEAM.RED].activeCard) {
          this.teams[TEAM.RED].errorCount += 1
        }

        this.teams[TEAM.BLUE].guessHistoryOther.push(this.teams[TEAM.BLUE].activeGuess)
        this.teams[TEAM.RED].guessHistorySelf.push(this.teams[TEAM.RED].activeGuess)

        this.teams[TEAM.RED].cardHistory.push(this.teams[TEAM.RED].activeCard)
        this.teams[TEAM.RED].activeCard = null
      },
      'onBlueReveal': () => {
        // Clear team guesses - [1,1,1] by default since its technically a valid selection
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeGuess = [1, 1, 1]
        }
      },
      'onBlueRevealGuesses': () => {
        // Make guesses public and check correctness
        if (this.teams[TEAM.RED].activeGuess === this.teams[TEAM.BLUE].activeCard) {
          this.teams[TEAM.RED].crackedCount += 1
        }
        if (this.teams[TEAM.BLUE].activeGuess !== this.teams[TEAM.BLUE].activeCard) {
          this.teams[TEAM.BLUE].errorCount += 1
        }

        this.teams[TEAM.RED].guessHistoryOther.push(this.teams[TEAM.RED].activeGuess)
        this.teams[TEAM.BLUE].guessHistorySelf.push(this.teams[TEAM.BLUE].activeGuess)

        this.teams[TEAM.BLUE].cardHistory.push(this.teams[TEAM.BLUE].activeCard)
        this.teams[TEAM.BLUE].activeCard = null
      },
      'onRoundEnd': () => {
        // Determine if there is a winner and automatically move to next state
        const teamsWon = new Set()
        const scores = { [TEAM.BLUE]: 0, [TEAM.RED]: 0 }
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          if (this.teams[team].crackedCount === 2) {
            teamsWon.add(team)
          }
          scores[team] += this.teams[team].crackedCount
          if(this.teams[team].errorCount === 2) {
            teamsWon.add({[TEAM.BLUE]: TEAM.RED, [TEAM.RED]: TEAM.BLUE}[team])
          }
          scores[team] -= this.teams[team].errorCount
        }
        if (teamsWon.size === 1) {
          this.winner = Array.from(teamsWon)[0]
          this.stateService.send(TRANSITION.END_GAME)
          return
        }
        if (teamsWon.size === 2) {
          if (scores[TEAM.BLUE] === scores[TEAM.RED]) {
            this.stateService.send(TRANSITION.TIE_BREAK)
            return
          }
          this.winner = scores[TEAM.BLUE] > scores[TEAM.RED] ? TEAM.BLUE : TEAM.RED
          this.stateService.send(TRANSITION.END_GAME)
          return
        }
        if (this.roundCount === this.maxRounds) {
          this.stateService.send(TRANSITION.TIE_BREAK)
          return
        }
        this.stateService.send(TRANSITION.START_ROUND)
      },
      'onTieBreak': () => {
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].tieBreakGuess = ['', '', '', '']
        }
      },
      'onTieBreakBuesses': () => {
        const scores = { [TEAM.BLUE]: 0, [TEAM.RED]: 0 }
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          for (const i of [0,1,2,3]) {
            if (natural.JaroWinklerDistance(this.teams[team].tieBreakGuess[i], this.teams[team].targetWords[i]) >= 0.9) {
              scores[team] += 1
            }
          }
        }
        if (scores[TEAM.BLUE] === scores[TEAM.RED]) {
          return
        }
        this.winner = scores[TEAM.BLUE] > scores[TEAM.RED] ? TEAM.BLUE : TEAM.RED
      }
    }
    this.stateService = interpret(createGameStateMachine(hooks))
    this.roundCount = 0
    this.winner = null
    this.stateService.start()
  }
  leaveTeam(team, socketId) {
    this.teams[team].receivers = this.teams[team].receivers.filter(id => id !== socketId)
    if (this.teams[team].caller === socketId) {
      this.teams[team].caller = null
    }
  }
  leaveAllTeams(socketId) {
    for (const team of Object.keys(this.teams)) {
      this.leaveTeam(team, socketId)
    }
  }
  getTeam(socketId) {
    for (const team of Object.keys(this.teams)) {
      if (this.isReceiverOf(team, socketId) || this.isCallerOf(team, socketId)) { return team }
    }
    return null
  }
  getRole(socketId) {
    for (const team of Object.keys(this.teams)) {
      if (this.isReceiverOf(team, socketId)) {
        return GAME_ROLE.RECEIVER
      }
      if (this.isCallerOf(team, socketId)) {
        return GAME_ROLE.CALLER
      }
    }
    return null
  }
  isCallerOf(team, socketId) {
    return this.teams[team].caller === socketId
  }
  isReceiverOf(team, socketId) {
    return this.teams[team].receivers.includes(socketId)
  }
  becomeCallerOf(team, socketId) {
    if (this.teams[team].caller != null) {
      return
    }
    this.leaveAllTeams(socketId)
    this.teams[team].caller = socketId
  }
  becomeReceiverOf(team, socketId) {
    this.leaveAllTeams(socketId)
    this.teams[team].receivers.push(socketId)
  }
  asSanitized(team, role, nameStore) {
    const sanitizedTeams = {}
    for (const teamMaybeOther of Object.keys(this.teams)) {
      if (team === teamMaybeOther) {
        if (role === GAME_ROLE.CALLER) {
          sanitizedTeams[team] = this.teams[team]
          continue
        }
        const { activeCard, ...rest } = this.teams[team]
        rest.caller = nameStore[rest.caller].username
        rest.receivers = rest.receivers.map(r => nameStore[r].username)
        sanitizedTeams[team] = rest
        continue
      }
      const { activeCard, targetWords, activeGuess, ...rest } = this.teams[teamMaybeOther]
      rest.caller = nameStore[rest.caller].username
      rest.receivers = rest.receivers.map(r => nameStore[r].username)
      sanitizedTeams[teamMaybeOther] = rest
    }

    return {
      roundCound: this.roundCount,
      state: this.stateService.state.value,
      teams: sanitizedTeams,
      winner: this.winner
    }
  }
}

module.exports.Game = Game