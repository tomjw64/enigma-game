const fs = require('fs')
const path = require('path')
const assert = require('assert').strict;

const express = require('express')
const app = express()
const cookieParser = require('cookie-parser')
const { parse: cookieParse } = require('cookie');
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
const SAVED_SESSIONS = {}
const CONNECTED_USERS = {}

const gameRoomCodeToSocketRoom = (gameRoomCode) => `game_${gameRoomCode}`

const usernameOf = (socket) => CONNECTED_USERS[socket.id]?.username
const currentGameCode = (socket) => CONNECTED_USERS[socket.id]?.gameRoomCode
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

const logIfError = (func) => {
  return (...args) => {
    try {
      func(...args)
    } catch (error) {
      console.error(error.stack);
    }
  }
}

const tryAssumeSession = (socket, session) => {
  if (session == null) {
    // No session to recover
    return false
  }
  const { team, role, socket: oldSocket, gameRoomCode: oldGameRoomCode } = session

  if (CONNECTED_USERS[oldSocket.id] == null) {
    // Old user data gone, can't recover session
    return false
  }

  const oldUserData = CONNECTED_USERS[oldSocket.id]
  const { gameRoomCode } = oldUserData

  if (gameRoomCode !== oldGameRoomCode) {
    // Old user data and old session data out of sync, maybe different room?
    return false
  }

  const game = gameFromRoomCode(gameRoomCode)
  if (game == null) {
    // Game is gone, can't recover session
    return false
  }

  // Remove old user data
  CONNECTED_USERS[socket.id] = { ...oldUserData }
  leaveCurrentGame(oldSocket)

  // Join correct game socket room
  const socketRoom = gameRoomCodeToSocketRoom(gameRoomCode)
  socket.join(socketRoom)

  // Join game
  const assumeRoleSuccess = game.makeRole(team, role, socket.id)
  if (!assumeRoleSuccess) {
    // May have been rejected because caller position now taken
    const assumeReceiverSuccess = game.makeRole(team, GAME_ROLE.RECEIVER, socket.id)
    if (!assumeReceiverSuccess) {
      throw new Error(`User should have been able to assume session but was not able to join any role`)
    }
  }
  return true
}

socketIO.on('connection', logIfError((socket) => {
  ///////////////////
  // ADMININISTRATIVE
  ///////////////////
  console.log('a user connected')
  CONNECTED_USERS[socket.id] = { username: socket.id, gameRoomCode: null }
  const socketLeaveGame = socketLeaveGameAction(socket)
  const cookies = cookieParse(socket.handshake.headers.cookie)
  const reconnectKey = cookies.reconnectKey

  const savedSession = SAVED_SESSIONS[reconnectKey]

  if (savedSession != null) {
    console.log(`existing session found for ${dbgSocket(socket)}`)
    const success = tryAssumeSession(socket, savedSession)
    if (success) {
      const { gameRoomCode, socket: oldSocket } = savedSession
      socketIO.to(socket.id).emit('assumed_session', { gameRoomCode, username: CONNECTED_USERS[oldSocket.id].username })
      console.log(`${dbgSocket(socket)} successfully assumed session from ${dbgSocket(oldSocket)}`)
      delete CONNECTED_USERS[oldSocket.id]
      emitUpdateGame(gameRoomCode)
    }
  }


  socket.on('disconnect', logIfError(() => {  
    const gameRoomCode = currentGameCode(socket)  
    const game = currentGame(socket)

    if (reconnectKey == null || game == null) {
      socketLeaveGame()
      delete CONNECTED_USERS[socket.id]
      return
    }

    const team = game.getTeam(socket.id)
    const role = game.getRole(socket.id)

    const instanceNo = (SAVED_SESSIONS[reconnectKey]?.instanceNo || 0) + 1

    // The user was in a game and has a cookie. We can revive the session if they reconnect
    SAVED_SESSIONS[reconnectKey] = { team, role, gameRoomCode, socket, instanceNo: instanceNo }
    setTimeout(() => {
      // if (CONNECTED_USERS[socket.id]?.reconnectCount === previousReconnectCount) {
        // User has not reconnected
      socketLeaveGame()
      console.log(`user ${dbgSocket(socket)} data being wiped`)
      delete CONNECTED_USERS[socket.id]
      // Only remove saved session if this is the same disconnect that caused the session to be saved
      if (SAVED_SESSIONS[reconnectKey]?.instanceNo === instanceNo) {
        delete SAVED_SESSIONS[reconnectKey]
      }
      // }
    }, 1200000)
    console.log(`user ${dbgSocket(socket)} disconnected`)
  }))
  socket.on('set_name', logIfError((username) => {
    CONNECTED_USERS[socket.id].username = username
    console.log(`user ${dbgSocket(socket)} set name: ${username}`)
    emitUpdateGame(currentGameCode(socket))
  }))
  socket.on('ensure_join_game', logIfError((gameRoomCode) => {
    const existingGame = gameFromRoomCode(gameRoomCode)

    if (existingGame != null && existingGame.getTeam(socket.id) != null && existingGame.getRole(socket.id) != null) {
      // socket has already joined game
      return
    }

    socketLeaveGame()
    console.log(`user ${dbgSocket(socket)} joined game: ${gameRoomCode}`)
    const socketRoom = gameRoomCodeToSocketRoom(gameRoomCode)
    socket.join(socketRoom)
    console.log(`user ${dbgSocket(socket)} joined room: ${socketRoom}`)
    CONNECTED_USERS[socket.id].gameRoomCode = gameRoomCode
    
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

app.use(cookieParser())
app.use(function (req, res, next) {
  const cookieName = 'reconnectKey'
  const cookie = req.cookies[cookieName]
  const cookieValue = cookie == null ? `reconnect_${Math.random().toString().substring(2)}` : cookie
  res.cookie(cookieName, cookieValue, { maxAge: 3600000, httpOnly: true })
  next()
})
app.use(express.static(BUILD_DIR))
app.get('/*', function (req, res) {
  res.sendFile(path.join(BUILD_DIR, 'index.html'))
})

const PORT = process.env.PORT || 9000
http.listen(PORT, () => {
  console.log(`listening on port ${PORT}`)
})
