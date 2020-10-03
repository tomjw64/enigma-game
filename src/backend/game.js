const { createMachine, interpret } = require('@xstate/fsm')
const { sampleSize, isEqual } = require('lodash')
const natural = require('natural')

const { toEnum } = require('../shared/utils')
const { TEAM } = require('../shared/team')
const { GAME_STATE } = require('../shared/game-state')
const { GAME_ROLE } = require('../shared/game-role')

const TRANSITION = toEnum([
  'RESTART_GAME',
  'START_ROUND',
  'NEXT_ROUND_STEP',
  'TIE_BREAK',
  'END_GAME'
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
        on: { [TRANSITION.NEXT_ROUND_STEP]: GAME_STATE.RED_REVEAL },
        entry: ['onRoundStart'],
        exit: ['onHintsCreated']
      },
      [GAME_STATE.RED_REVEAL]: {
        on: { [TRANSITION.NEXT_ROUND_STEP]: GAME_STATE.BLUE_REVEAL },
        entry: ['onRedReveal'],
        exit: ['onRedRevealGuesses']
      },
      [GAME_STATE.BLUE_REVEAL]: {
        on: { [TRANSITION.NEXT_ROUND_STEP]: GAME_STATE.ROUND_END },
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
      [GAME_STATE.TIE_BREAK]: {
        on: { [TRANSITION.END_GAME]: GAME_STATE.GAME_END },
        entry: ['onTieBreak'],
        exit: ['onTieBreakGuesses']
      },
      [GAME_STATE.GAME_END]: {
        on: { [TRANSITION.RESTART_GAME]: GAME_STATE.GAME_INIT },
        entry: ['onGameEnd']
      }
    }
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
    tieBreakGuess: null, // Array<string> of length 4, public
    activeHint: null, // Array<string> of length 3, public
    activeGuess: null, // Array<int> of length 3, public
    activeGuessSubmitted: false, // bool, public
    activeHintSubmitted: false, // bool, public
    tieBreakGuessSubmitted: false // bool, public
  }
}

class Game {
  constructor (words, maxRounds) {
    this.words = words
    this.maxRounds = maxRounds
    const hooks = {
      onGameInit: () => {
        this.roundCount = 0
        this.winner = null
        this.teams = {
          [TEAM.BLUE]: createTeam(),
          [TEAM.RED]: createTeam(),
          [TEAM.SPECTATORS]: createTeam()
        }
      },
      onGameStart: () => {
        // Populate the target words for teams
        const noDuplicateSample = sampleSize(words, 8)
        this.teams[TEAM.RED].targetWords = noDuplicateSample.slice(0, 4)
        this.teams[TEAM.BLUE].targetWords = noDuplicateSample.slice(4)
      },
      onRoundStart: () => {
        // Increment round counter
        this.roundCount += 1
        // Draw a new card for hint creation for target words
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeCard = sampleSize(['1', '2', '3', '4'], 3)
          this.teams[team].activeHint = null
          this.teams[team].activeHintSubmitted = false
          this.teams[team].activeGuessSubmitted = false
        }
      },
      onHintsCreated: () => {
        // Make created hints publicly viewable
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].hintHistory.push(this.teams[team].activeHint)
        }
      },
      onRedReveal: () => {
        // Clear team guesses - [1,1,1] by default since its technically a valid selection
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeGuess = ['1', '1', '1']
          this.teams[team].activeGuessSubmitted = false
        }
        if (this.roundCount === 1) {
          // Intentionally force guess wrong the first round
          this.teams[TEAM.BLUE].activeGuessSubmitted = true
        }
      },
      onRedRevealGuesses: () => {
        // Make guesses public and check correctness
        if (isEqual(this.teams[TEAM.BLUE].activeGuess, this.teams[TEAM.RED].activeCard)) {
          this.teams[TEAM.BLUE].crackedCount += 1
        }
        if (!isEqual(this.teams[TEAM.RED].activeGuess, this.teams[TEAM.RED].activeCard)) {
          this.teams[TEAM.RED].errorCount += 1
        }

        this.teams[TEAM.BLUE].guessHistoryOther.push(this.teams[TEAM.BLUE].activeGuess)
        this.teams[TEAM.RED].guessHistorySelf.push(this.teams[TEAM.RED].activeGuess)

        this.teams[TEAM.RED].cardHistory.push(this.teams[TEAM.RED].activeCard)
        this.teams[TEAM.RED].activeCard = null
      },
      onBlueReveal: () => {
        // Clear team guesses - [1,1,1] by default since its technically a valid selection
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].activeGuess = ['1', '1', '1']
          this.teams[team].activeGuessSubmitted = false
        }
        if (this.roundCount === 1) {
          // Intentionally force guess wrong the first round
          this.teams[TEAM.RED].activeGuessSubmitted = true
        }
      },
      onBlueRevealGuesses: () => {
        // Make guesses public and check correctness
        if (isEqual(this.teams[TEAM.RED].activeGuess, this.teams[TEAM.BLUE].activeCard)) {
          this.teams[TEAM.RED].crackedCount += 1
        }
        if (!isEqual(this.teams[TEAM.BLUE].activeGuess, this.teams[TEAM.BLUE].activeCard)) {
          this.teams[TEAM.BLUE].errorCount += 1
        }

        this.teams[TEAM.RED].guessHistoryOther.push(this.teams[TEAM.RED].activeGuess)
        this.teams[TEAM.BLUE].guessHistorySelf.push(this.teams[TEAM.BLUE].activeGuess)

        this.teams[TEAM.BLUE].cardHistory.push(this.teams[TEAM.BLUE].activeCard)
        this.teams[TEAM.BLUE].activeCard = null
      },
      onRoundEnd: () => {
        // Determine if there is a winner and automatically move to next state
        const teamsWon = new Set()

        const threshold = 2

        const scores = { [TEAM.BLUE]: 0, [TEAM.RED]: 0 }

        const otherTeam = {
          [TEAM.BLUE]: TEAM.RED,
          [TEAM.RED]: TEAM.BLUE
        }

        for (const team of [TEAM.RED, TEAM.BLUE]) {
          if (this.teams[team].crackedCount === threshold) {
            teamsWon.add(team)
          }
          scores[team] += this.teams[team].crackedCount
          if (this.teams[team].errorCount === threshold) {
            teamsWon.add(otherTeam[team])
          }
          scores[team] -= this.teams[team].errorCount
        }
        if (teamsWon.size === 1) {
          const winningTeam = Array.from(teamsWon)[0]
          const winningReason = this.teams[winningTeam].crackedCount === threshold
            ? `${winningTeam} cracked code ${threshold} times`
            : `${otherTeam[winningTeam]} made ${threshold} errors`
          this.winner = { team: winningTeam, reason: winningReason }
          this.stateService.send(TRANSITION.END_GAME)
          return
        }
        if (teamsWon.size === 2) {
          if (scores[TEAM.BLUE] === scores[TEAM.RED]) {
            this.stateService.send(TRANSITION.TIE_BREAK)
            return
          }
          const winningTeam = scores[TEAM.BLUE] > scores[TEAM.RED] ? TEAM.BLUE : TEAM.RED
          this.winner = { team: winningTeam, reason: `${winningTeam} had better success rates` }
          this.stateService.send(TRANSITION.END_GAME)
          return
        }
        if (this.roundCount === this.maxRounds) {
          this.stateService.send(TRANSITION.TIE_BREAK)
          return
        }
        this.stateService.send(TRANSITION.START_ROUND)
      },
      onTieBreak: () => {
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          this.teams[team].tieBreakGuess = ['', '', '', '']
          this.teams[team].tieBreakGuessSubmitted = false
        }
      },
      onTieBreakGuesses: () => {
        const scores = { [TEAM.BLUE]: 0, [TEAM.RED]: 0 }
        const otherTeam = {
          [TEAM.RED]: TEAM.BLUE,
          [TEAM.BLUE]: TEAM.RED
        }
        for (const team of [TEAM.RED, TEAM.BLUE]) {
          for (const i of [0, 1, 2, 3]) {
            if (natural.JaroWinklerDistance(this.teams[team].tieBreakGuess[i].toUpperCase(), this.teams[otherTeam[team]].targetWords[i].toUpperCase()) >= 0.9) {
              scores[team] += 1
            }
          }
        }
        if (scores[TEAM.BLUE] === scores[TEAM.RED]) {
          this.winner = { team: 'NONE', reason: `Both teams guessed ${scores[TEAM.BLUE]} words correct` }
          return
        }
        const winningTeam = scores[TEAM.BLUE] > scores[TEAM.RED] ? TEAM.BLUE : TEAM.RED
        this.winner = { team: winningTeam, reason: `${winningTeam} guessed ${scores[winningTeam]} words correctly - ${otherTeam[winningTeam]} only guessed ${scores[otherTeam[winningTeam]]}` }
      }
    }
    this.stateService = interpret(createGameStateMachine(hooks))
    this.stateService.start()
  }

  leaveTeam (team, socketId) {
    this.teams[team].receivers = this.teams[team].receivers.filter(id => id !== socketId)
    if (this.teams[team].caller === socketId) {
      this.teams[team].caller = null
    }
  }

  leaveAllTeams (socketId) {
    for (const team of Object.keys(this.teams)) {
      this.leaveTeam(team, socketId)
    }
  }

  getTeam (socketId) {
    for (const team of Object.keys(this.teams)) {
      if (this.isReceiverOf(team, socketId) || this.isCallerOf(team, socketId)) { return team }
    }
    return null
  }

  getRole (socketId) {
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

  isCallerOf (team, socketId) {
    return this.teams[team].caller === socketId
  }

  isReceiverOf (team, socketId) {
    return this.teams[team].receivers.includes(socketId)
  }

  makeCaller (team, socketId) {
    if (this.teams[team].caller != null) {
      return false
    }
    this.leaveAllTeams(socketId)
    this.teams[team].caller = socketId
    return true
  }

  makeReceiver (team, socketId) {
    if (this.isReceiverOf(team, socketId)) {
      return false
    }
    this.leaveAllTeams(socketId)
    this.teams[team].receivers.push(socketId)
    return true
  }

  makeRole (team, role, socketId) {
    const funcSwitch = { [GAME_ROLE.CALLER]: this.makeCaller.bind(this), [GAME_ROLE.RECEIVER]: this.makeReceiver.bind(this) }
    return funcSwitch[role](team, socketId)
  }

  asSanitized (team, role, nameStore, allPublic) {
    const sanitizedTeams = {}
    for (const teamMaybeOther of Object.keys(this.teams)) {
      if (teamMaybeOther === TEAM.SPECTATORS) {
        const { caller, receivers } = this.teams[TEAM.SPECTATORS]
        sanitizedTeams[teamMaybeOther] = { caller, receivers }
        continue
      }
      if (team === teamMaybeOther || allPublic) {
        if (role === GAME_ROLE.CALLER || allPublic) {
          sanitizedTeams[teamMaybeOther] = { ...this.teams[teamMaybeOther] }
          continue
        }
        const { activeCard, ...rest } = this.teams[teamMaybeOther]
        sanitizedTeams[teamMaybeOther] = rest
        continue
      }
      const { activeCard, targetWords, ...rest } = this.teams[teamMaybeOther]
      sanitizedTeams[teamMaybeOther] = rest
    }

    for (const sanitizedTeam of Object.values(sanitizedTeams)) {
      if (sanitizedTeam.caller != null) { sanitizedTeam.caller = nameStore[sanitizedTeam.caller].username }
      sanitizedTeam.receivers = sanitizedTeam.receivers.map(r => nameStore[r].username)
    }

    return {
      me: { team, role },
      roundCound: this.roundCount,
      state: this.getState(),
      teams: sanitizedTeams,
      winner: this.winner
    }
  }

  getState () {
    return this.stateService.state.value
  }

  sendTransition (event) {
    this.stateService.send(event)
  }

  setActiveHint (team, hint) {
    this.teams[team].activeHint = hint
    this.teams[team].activeHintSubmitted = true
  }

  isActiveHintSubmitted (team) {
    return this.teams[team].activeHintSubmitted
  }

  setActiveGuess (team, guess) {
    if (!(guess instanceof Array && guess.length === 3)) {
      console.log(`bad guess data: ${guess}`)
      return
    }
    this.teams[team].activeGuess = guess
  }

  isActiveGuessSubmitted (team) {
    return this.teams[team].activeGuessSubmitted
  }

  setActiveGuessSubmitted (team) {
    this.teams[team].activeGuessSubmitted = true
  }

  setTieBreakGuess (team, guess) {
    if (!(guess instanceof Array && guess.length === 4)) {
      console.log(`bad guess data: ${guess}`)
      return
    }
    this.teams[team].tieBreakGuess = guess
  }

  setTieBreakGuessSubmitted (team) {
    this.teams[team].tieBreakGuessSubmitted = true
  }

  isTieBreakGuessSubmitted (team) {
    return this.teams[team].tieBreakGuessSubmitted
  }
}

module.exports.Game = Game
module.exports.TRANSITION = TRANSITION
