const fs = require('fs')
const path = require('path')
const assert = require('assert').strict;

const express = require('express')
const app = express()
const http = require('http').createServer(app)
const socketIO = require('socket.io')(http)

const { Game, TRANSITION } = require('./game')

const { TEAM } = require('../shared/team')
const { GAME_STATE } = require('../shared/game-state')
const { GAME_ROLE } = require('../shared/game-role')

const BUILD_DIR = path.resolve('build')

const WORDS = fs.readFileSync(path.join(BUILD_DIR, '/words.txt'), { encoding: 'utf8' }).split('\n').map(word => word.toUpperCase())
console.log(`Loaded ${WORDS.length} words`)

const GAMES = {}

const CONNECTED_USERS = {}

const gameRoomCodeToSocketRoom = (gameRoomCode) => `game_${gameRoomCode}`

const usernameOf = (socket) => CONNECTED_USERS[socket.id].username
// const usernameFromId = (socketId) => socketId == null ? null : CONNECTED_USERS[socketId].username
const currentGameCode = (socket) => CONNECTED_USERS[socket.id].gameRoomCode
const currentGame = (socket) => gameFromRoomCode(currentGameCode(socket))
const gameFromRoomCode = (roomCode) => GAMES[roomCode]


const leaveCurrentGame = (socket) => {
  const currentGameRoomCode = currentGameCode(socket)
  const socketRoom = gameRoomCodeToSocketRoom(currentGameRoomCode)
  socket.leave(socketRoom)
  console.log(`user ${dbgSocket(socket)} left room: ${socketRoom}`)
  const currentGame = gameFromRoomCode(currentGameRoomCode)
  if (currentGame != null) {
    currentGame.leaveAllTeams(socket.id)
  }
  CONNECTED_USERS[socket.id].gameRoomCode = null
}

const emitUpdateGame = (gameRoomCode) => {
  const existingGame = gameFromRoomCode(gameRoomCode)
  if (existingGame == null) { return }

  const allPublic = existingGame.getState() === GAME_STATE.GAME_END

  const sanitizedGameState = {}
  for (const team of Object.keys(TEAM)) {
    sanitizedGameState[team] = {}
    for (const role of Object.keys(GAME_ROLE)) {
      sanitizedGameState[team][role] = existingGame.asSanitized(team, role, CONNECTED_USERS, allPublic)
    }
  }
  const socketRoom = gameRoomCodeToSocketRoom(gameRoomCode)
  socketIO.in(socketRoom).clients((err, clients) => {
    if (err) { throw err }
    for (const client of clients) {
      const team = existingGame.getTeam(client)
      const role = existingGame.getRole(client)
      if (team != null && role != null) {
        socketIO.to(client).emit('update_game', sanitizedGameState[team][role])
      }
    }
  })
  console.log(`issued update`)
}

const dbgSocket = (socket) => `(${socket.id}:${usernameOf(socket)})`
// const dbgSocketId = (socketId) => `(${socketId}:${usernameFromId(socketId)})`

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

const logIfError = (func) => {
  return (...args) => {
    try {
      func(...args)
    } catch (error) {
      console.error(error.stack);
      // console.error(error.name);
      // console.error(error.message);
    }
  }
}

socketIO.on('connection', logIfError((socket) => {
  ///////////////////
  // ADMININISTRATIVE
  ///////////////////
  console.log('a user connected')
  CONNECTED_USERS[socket.id] = { username: socket.id, gameRoomCode: null }
  const socketLeaveGame = socketLeaveGameAction(socket)

  socket.on('disconnect', logIfError(() => {
    socketLeaveGame()
    console.log(`user ${dbgSocket(socket)} disconnected`)
    delete CONNECTED_USERS[socket.id]
  }))
  socket.on('set_name', logIfError((username) => {
    CONNECTED_USERS[socket.id].username = username
    console.log(`user ${dbgSocket(socket)} set name: ${username}`)
    emitUpdateGame(currentGameCode(socket))
  }))
  socket.on('join_game', logIfError((gameRoomCode) => {
    socketLeaveGame()
    console.log(`user ${dbgSocket(socket)} joined game: ${gameRoomCode}`)
    const socketRoom = gameRoomCodeToSocketRoom(gameRoomCode)
    socket.join(socketRoom)
    console.log(`user ${dbgSocket(socket)} joined room: ${socketRoom}`)
    CONNECTED_USERS[socket.id].gameRoomCode = gameRoomCode

    const existingGame = gameFromRoomCode(gameRoomCode)
    if (existingGame != null) {
      existingGame.makeReceiver(TEAM.SPECTATORS, socket.id)
    }

    emitUpdateGame(gameRoomCode)
  }))
  socket.on('leave_game', logIfError(socketLeaveGame))
  socket.on('create_game', logIfError((gameRoomCode) => {
    console.log(`user ${dbgSocket(socket)} created game: ${gameRoomCode}`)
    const existingGame = GAMES[gameFromRoomCode]
    if (existingGame == null) {
      GAMES[gameRoomCode] = new Game(WORDS, 6)
    }
    socketIO.to(gameRoomCodeToSocketRoom(gameRoomCode)).emit('game_created')
  }))
  socket.on('set_role', logIfError((team, role) => {
    const game = currentGame(socket)
    if (game == null) {
      return
    }
    game.makeRole(team, role, socket.id)
    emitUpdateGame(currentGameCode(socket))
  }))
  socket.on('try_reconnect', () => {
    console.log('socket tried reconnect')
  })

  /////////////////
  // IN GAME EVENTS
  /////////////////
  socket.on('start_game', logIfError(() => {
    const game = currentGame(socket)
    assert.equal(game.getState(), GAME_STATE.GAME_INIT)
    game.sendTransition(TRANSITION.START_ROUND)
    emitUpdateGame(currentGameCode(socket))
  }))

  socket.on('hint_submit', logIfError((data) => {
    const game = currentGame(socket)
    assert.equal(game.getState(), GAME_STATE.CREATE_HINTS)
    if (!(data instanceof Array && data.length === 3)) {
      console.log(`bad hint data: ${data}`)
      return
    }

    const team = game.getTeam(socket.id)
    game.setActiveHint(team, data)

    if (game.isActiveHintSubmitted(TEAM.RED) && game.isActiveHintSubmitted(TEAM.BLUE)) {
      game.sendTransition(TRANSITION.NEXT_ROUND_STEP)
    }

    emitUpdateGame(currentGameCode(socket))
  }))

  socket.on('guess_change', logIfError((data) => {
    const game = currentGame(socket)
    const acceptableStates = [
      GAME_STATE.RED_REVEAL,
      GAME_STATE.BLUE_REVEAL
    ]
    if (!acceptableStates.includes(game.getState())) {
      console.log(`guess could not be submitted because state is ${game.getState()}, not any of ${acceptableStates}`)
      return
    }

    const team = game.getTeam(socket.id)
    const role = game.getRole(socket.id)
    
    if (role === GAME_ROLE.CALLER) {
      if ((team === TEAM.RED && game.getState() === GAME_STATE.RED_REVEAL)
          || (team == TEAM.BLUE && game.getState() === GAME_STATE.BLUE_REVEAL)) {
        console.log(`player without permission to change guess tried to change guess`)
      }
    }

    game.setActiveGuess(team, data)

    emitUpdateGame(currentGameCode(socket))
  }))

  socket.on('guess_submit', logIfError(() => {
    const game = currentGame(socket)
    const acceptableStates = [
      GAME_STATE.RED_REVEAL,
      GAME_STATE.BLUE_REVEAL
    ]
    if (!acceptableStates.includes(game.getState())) {
      console.log(`guess could not be submitted because state is ${game.getState()}, not any of ${acceptableStates}`)
      return
    }

    const team = game.getTeam(socket.id)
    const role = game.getRole(socket.id)
    
    if (role === GAME_ROLE.CALLER) {
      if ((team === TEAM.RED && game.getState() === GAME_STATE.RED_REVEAL)
          || (team == TEAM.BLUE && game.getState() === GAME_STATE.BLUE_REVEAL)) {
        console.log(`player without permission to submit guess tried to submit guess`)
      }
    }

    game.setActiveGuessSubmitted(team)
    if (game.isActiveGuessSubmitted(TEAM.RED) && game.isActiveGuessSubmitted(TEAM.BLUE)) {
      game.sendTransition(TRANSITION.NEXT_ROUND_STEP)
    }

    emitUpdateGame(currentGameCode(socket))
  }))

  socket.on('tiebreak_change', logIfError((data) => {
    const game = currentGame(socket)
    if (game.getState() !== GAME_STATE.TIE_BREAK) {
      console.log(`tiebreak guess could not submit because state is ${game.getState()}, not ${GAME_STATE.TIE_BREAK}`)
      return
    }

    const team = game.getTeam(socket.id)

    game.setTieBreakGuess(team, data)

    emitUpdateGame(currentGameCode(socket))

  }))

  socket.on('tiebreak_submit', logIfError(() => {
    const game = currentGame(socket)
    if (game.getState() !== GAME_STATE.TIE_BREAK) {
      console.log(`tiebreak guess could not submit because state is ${game.getState()}, not ${GAME_STATE.TIE_BREAK}`)
      return
    }

    const team = game.getTeam(socket.id)

    game.setTieBreakGuessSubmitted(team)

    if (game.isTieBreakGuessSubmitted(TEAM.RED) && game.isTieBreakGuessSubmitted(TEAM.BLUE)) {
      game.sendTransition(TRANSITION.END_GAME)
    }

    emitUpdateGame(currentGameCode(socket))
  }))
}))

const PORT = process.env.PORT || 9000
http.listen(PORT, () => {
  console.log(`listening on port ${PORT}`)
})
