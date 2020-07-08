const fs = require('fs')
const path = require('path')

const lodash = require('lodash')

const express = require('express')
const app = express()
const http = require('http').createServer(app)
const socketIO = require('socket.io')(http)

const { TEAM } = require('../shared/team')
const { GAME_STATE } = require('../shared/game-state')
const { GAME_ROLE } = require('../shared/game-role')

const BUILD_DIR = path.resolve('build')

const WORDS = fs.readFileSync(path.join(BUILD_DIR, '/words.txt'), { encoding: 'utf8' }).split('\n').map(word => word.toUpperCase())
console.log(`Loaded ${WORDS.length} words`)

const GAMES = {}

const CONNECTED_USERS = {}

const newTeam = () => {
  return {
    public: {
      caller: null,
      receivers: [],
      hintHistory: [],
      guessHistorySelf: [],
      guessHistoryOther: [],
      crackedCount: 0,
      errorCount: 0
    },
    private: {
      activeCard: null,
      targetWords: [],
      activeHint: [],
      activeGuess: []
    },
    caller: {
      activeCard: null
    }
  }
}

const newGame = () => {
  return {
    state: GAME_STATE.GAME_INIT,
    roundCount: 0,
    teams: {
      [TEAM.BLUE]: newTeam(),
      [TEAM.RED]: newTeam(),
      [TEAM.SPECTATORS]: newTeam()
    }
  }
}

const gameRoomCodeToSocketRoom = (gameRoomCode) => `game_${gameRoomCode}`
const gameRoomCodeToSocketTeamRoom = (gameRoomCode, team) => `game_${gameRoomCode}_team_${team}`

const usernameOf = (socket) => CONNECTED_USERS[socket.id].username
const usernameFromId = (socketId) => socketId == null ? null : CONNECTED_USERS[socketId].username
const currentGameCode = (socket) => CONNECTED_USERS[socket.id].gameRoomCode
const currentGame = (socket) => gameFromRoomCode(currentGameCode(socket))
const gameFromRoomCode = (roomCode) => GAMES[roomCode]

const getTeam = (game, socket) => getTeamFromId(game, socket.id)
const getTeamFromId = (game, socketId) => {
  for (const team of Object.keys(game.teams)) {
    const inReceivers = game.teams[team].public.receivers.includes(socketId)
    const isCaller = game.teams[team].public.caller === socketId
    if (inReceivers || isCaller) { return team }
  }
  return null
}

// const isMemberOf = (game, team, socket) => {
//   return isCallerOf(game, team, socket) || isReceiverOf(game, team, socket)
// }
const isCallerOf = (game, team, socket) => isIdCallerOf(game, team, socket.id)
const isIdCallerOf = (game, team, socketId) => game.teams[team].public.caller == socketId
const isReceiverOf = (game, team, socket) => isIdReceiverOf(game, team, socket.id)
const isIdReceiverOf = (game, team, socketId) => game.teams[team].public.receivers.includes(socketId)
const getRoleFromID = (game, team, socketId) => {
  if (isIdCallerOf(game, team, socketId)) {
    return GAME_ROLE.CALLER
  }
  if (isIdReceiverOf(game, team, socketId)) {
    return GAME_ROLE.RECEIVER
  }
  return null
}

const becomeCaller = (socket) => {
  const game = currentGame(socket)
  if (game == null) {
    throw new Error(`no current game found for user ${dbgSocket(socket)}.`)
  }
  const team = getTeam(game, socket)
  if (game.teams[team].public.caller != null) {
    // Only one caller
    console.log(`user ${dbgSocket(socket)} tried to become caller but ${dbgSocketId(game.teams[team].public.caller)} was already caller`)
    return
  }
  game.teams[team].public.receivers = game.teams[team].public.receivers.filter(id => id !== socket.id)
  game.teams[team].public.caller = socket.id
}

const becomeReceiver = (socket) => {
  const game = currentGame(socket)
  if (game == null) {
    throw new Error(`no current game found for user ${dbgSocket(socket)}.`)
  }
  const team = getTeam(game, socket)
  if (isReceiverOf(game, team, socket)) {
    console.log(`user ${dbgSocket(socket)} tried to become receiver but was already`)
    return
  }
  if (isCallerOf(game, team, socket)) {
    game.teams[team].public.caller = null
  }
  game.teams[team].public.receivers.push(socket.id)
}

const joinTeam = (team, socket) => {
  const gameRoomCode = currentGameCode(socket)
  const existingGame = gameFromRoomCode(gameRoomCode)
  if (existingGame == null) {
    throw new Error(`no current game found for user ${dbgSocket(socket)}.`)
  }
  const existingTeam = getTeam(existingGame, socket)
  if (existingTeam === team) { return }
  leaveAllGameTeams(gameRoomCode, socket)
  const socketTeamRoom = gameRoomCodeToSocketTeamRoom(gameRoomCode, team)
  socket.join(socketTeamRoom)
  console.log(`user ${dbgSocket(socket)} joined room: ${socketTeamRoom}`)
  existingGame.teams[team].public.receivers.push(socket.id)
  console.log(`user ${dbgSocket(socket)} added to team: ${team}`)
}

const leaveCurrentGame = (socket) => {
  const currentGameRoomCode = currentGameCode(socket)
  leaveAllGameTeams(currentGameRoomCode, socket)
  const socketRoom = gameRoomCodeToSocketRoom(currentGameRoomCode)
  socket.leave(socketRoom)
  console.log(`user ${dbgSocket(socket)} left room: ${socketRoom}`)
  // const currentGame = gameFromRoomCode(currentGameRoomCode)
  CONNECTED_USERS[socket.id].gameRoomCode = null
}

const leaveAllGameTeams = (gameRoomCode, socket) => {
  const socketRoomTeamPrefix = gameRoomCodeToSocketRoom(gameRoomCode) + '_team_'
  for (const room of Object.keys(socket.rooms).filter((room) => room.startsWith(socketRoomTeamPrefix))) {
    socket.leave(room)
    console.log(`user ${dbgSocket(socket)} left room: ${room}`)
  }
  const currentGame = gameFromRoomCode(gameRoomCode)
  if (currentGame != null) {
    for (const team of Object.keys(currentGame.teams)) {
      currentGame.teams[team].public.receivers = currentGame.teams[team].public.receivers.filter(id => id !== socket.id)
      if (currentGame.teams[team].public.caller === socket.id) {
        currentGame.teams[team].public.caller = null
      }
    }
  }
}

const emitUpdateGame = (gameRoomCode) => {
  const existingGame = gameFromRoomCode(gameRoomCode)
  if (existingGame == null) { return }
  for (const team of Object.keys(TEAM)) {
    socketIO.to(gameRoomCodeToSocketTeamRoom(gameRoomCode, team)).emit('update_game', sanitizeGameState(existingGame, team))
  }
  socketIO.in(gameRoomCodeToSocketRoom(gameRoomCode)).clients((err, clients) => {
    if (err) { throw err }
    for (const client of clients) {
      console.log(`updating client ${client}`)
      const team = getTeamFromId(existingGame, client)
      if (team != null) {
        // It is possible the player has not yet joined a team because the game has just started
        socketIO.to(client).emit('update_player_state', {team, role: getRoleFromID(existingGame, team, client)})
      }
    }
  })
}

const sanitizeGameState = (gameState, team) => {
  if (gameState == null) { return null }
  const valueMap = (obj, path, f) => {
    const newObj = { ...obj }
    let location = newObj
    for (let i = 0; i < path.length - 1; i++) {
      location = location[path[i]]
    }
    location[path[path.length - 1]] = f(location[path[path.length - 1]])

    return newObj
  }

  const mapReceiversToUserNames = (publicObj) => {
    return valueMap(publicObj, ['receivers'], (arr) => arr.map(usernameFromId))
  }
  const mapCallerToUserName = (publicObj) => {
    return valueMap(publicObj, ['caller'], usernameFromId)
  }
  const mapSocketIdsToUserName = (publicObj) => {
    return mapCallerToUserName(mapReceiversToUserNames(publicObj))
  }

  const { roundCount, state } = gameState

  const sanitized = {
    roundCount,
    state,
    teams: {
      [TEAM.BLUE]: { public: mapSocketIdsToUserName(gameState.teams[TEAM.BLUE].public) },
      [TEAM.RED]: { public: mapSocketIdsToUserName(gameState.teams[TEAM.RED].public) },
      [TEAM.SPECTATORS]: { public: mapSocketIdsToUserName(gameState.teams[TEAM.SPECTATORS].public) }
    }
  }
  sanitized.teams[team].private = gameState.teams[team].private

  return sanitized
}

const dbgSocket = (socket) => `(${socket.id}:${usernameOf(socket)})`
const dbgSocketId = (socketId) => `(${socketId}:${usernameFromId(socketId)})`
// const dbgGame = (game) => JSON.stringify(game, null, 2)

const onGameStart = (game) => {
  // Populate the target words for teams
  const noDuplicateSample = lodash.sampleSize(WORDS, 8)
  game.teams[TEAM.RED].private.targetWords = noDuplicateSample.slice(0,4)
  game.teams[TEAM.BLUE].private.targetWords = noDuplicateSample.slice(4)
}

const onStateEnterCreateHints = (game) => {
  for (const team of [TEAM.RED, TEAM.BLUE]) {
    game.teams[team].private.activeCard = lodash.sampleSize([1,2,3,4], 3)
  }
}

const onStateEnterRedRevealBlueGuess = (game) => {
  game.teams[TEAM.RED].public.hintHistory.push(game.teams[TEAM.RED].private.activeHint)
  game.teams[TEAM.RED].private.activeHint = [1,1,1]
}

const socketLeaveGameAction = (socket) => {
  return () => {
    if (currentGameCode(socket) == null) {
      return
    }
    const currentGameRoomCode = currentGameCode(socket)
    leaveCurrentGame(socket)
    console.log(`user ${dbgSocket(socket)} left game: ${currentGameRoomCode}`)
    emitUpdateGame(currentGameRoomCode)
    socketIO.to(socket.id).emit('update_game', null)
  }
}

app.use(express.static(BUILD_DIR))
app.get('/*', function (req, res) {
  res.sendFile(path.join(BUILD_DIR, 'index.html'))
})

socketIO.on('connection', (socket) => {
  ///////////////////
  // ADMININISTRATIVE
  ///////////////////
  console.log('a user connected')
  CONNECTED_USERS[socket.id] = { username: socket.id, gameRoomCode: null }
  const socketLeaveGame = socketLeaveGameAction(socket)

  socket.on('disconnect', () => {
    console.log(`user ${dbgSocket(socket)} disconnecting`)
    socketLeaveGame()
    console.log(`user ${dbgSocket(socket)} disconnected`)
    delete CONNECTED_USERS[socket.id]
  })
  socket.on('set_name', (username) => {
    console.log(`user ${dbgSocket(socket)} set name: ${username}`)
    CONNECTED_USERS[socket.id].username = username
    emitUpdateGame(currentGameCode(socket))
  })
  socket.on('join_game', (gameRoomCode) => {
    socketLeaveGame()
    console.log(`user ${dbgSocket(socket)} joined game: ${gameRoomCode}`)
    const socketRoom = gameRoomCodeToSocketRoom(gameRoomCode)
    socket.join(socketRoom)
    console.log(`user ${dbgSocket(socket)} joined room: ${socketRoom}`)
    CONNECTED_USERS[socket.id].gameRoomCode = gameRoomCode
    if (gameFromRoomCode(gameRoomCode) != null) {
      joinTeam(TEAM.SPECTATORS, socket)
    }
    emitUpdateGame(gameRoomCode)
  })
  socket.on('join_team', (team) => {
    // TODO decide whether to join automatically or to prompt existing team to allow in
    joinTeam(team, socket)
    emitUpdateGame(currentGameCode(socket))
  })
  socket.on('leave_game', socketLeaveGame)
  socket.on('create_game', (gameRoomCode) => {
    console.log(`user ${dbgSocket(socket)} created game: ${gameRoomCode}`)
    GAMES[gameRoomCode] = newGame()
    socketIO.to(gameRoomCodeToSocketRoom(gameRoomCode)).emit('game_created')
  })
  socket.on('become_caller', () => {
    becomeCaller(socket)
    emitUpdateGame(currentGameCode(socket))
  })
  socket.on('become_receiver', () => {
    becomeReceiver(socket)
    emitUpdateGame(currentGameCode(socket))
  })

  /////////////////
  // IN GAME EVENTS  && We'll want to turn this into a state machine that fires events at some point, I assume
  /////////////////
  socket.on('start_game', () => {
    const game = currentGame(socket)
    if (game.state !== GAME_STATE.GAME_INIT) {
      console.log(`game could not be started because state is ${game.state}, not ${GAME_STATE.GAME_INIT}`)
      return
    }
    // TODO validate
    game.state = GAME_STATE.CREATE_HINTS
    onGameStart(game)
    onStateEnterCreateHints(game)
    emitUpdateGame(currentGameCode(socket))
  })

  socket.on('submit_hint', (data) => {
    const game = currentGame(socket)
    if (game.state !== GAME_STATE.CREATE_HINTS) {
      console.log(`hint could not be submitted because state is ${game.state}, not ${GAME_STATE.CREATE_HINTS}`)
      return
    }

    const team = getTeam(game, socket)
    game.teams[team].private.activeHint = data

    if (game.teams[TEAM.RED].private.activeHint.length > 0 && game.teams[TEAM.BLUE].private.activeHint.length > 0) {
      game.state = GAME_STATE.RED_REVEAL_BLUE_GUESS
      onStateEnterRedRevealBlueGuess(game)
    }

    emitUpdateGame(currentGameCode(socket))
  })

  socket.on('guess_changed', (data) => {
    const game = currentGame(socket)
    const acceptableStates = [
      GAME_STATE.RED_REVEAL_BLUE_GUESS,
      GAME_STATE.RED_REVEAL_RED_GUESS,
      GAME_STATE.BLUE_REVEAL_RED_GUESS,
      GAME_STATE.BLUE_REVEAL_BLUE_GUESS
    ]
    if (!acceptableStates.includes(game.state)) {
      console.log(`hint could not be submitted because state is ${game.state}, not any of ${acceptableStates}`)
      return
    }

    const team = getTeam(game, socket)
    game.teams[team].private.activeGuess = data
    emitUpdateGame(currentGameCode(socket))
  })

})

const PORT = 9000
http.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`)
})
