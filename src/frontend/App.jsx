import React, { createContext, useReducer, useState, useContext, useEffect } from 'react'
import './App.css'
import io from 'socket.io-client'
import { BrowserRouter, Route, withRouter } from 'react-router-dom'
import { toEnum } from '../shared/utils'
import { TEAM } from '../shared/team'
import { GAME_STATE } from '../shared/game-state'
import { GAME_ROLE } from '../shared/game-role'

const SOCKET = io()

const ACTIONS = toEnum([
  'SET_NAME',
  'SET_JOINED_GAME',
  'SET_GAME_STATE',
  'SET_SERVER_PLAYER_STATE',
])

const Reducer = (state, action) => {
  switch (action.type) {
    case ACTIONS.SET_NAME:
      return {
        ...state,
        userName: action.payload
      }
    case ACTIONS.SET_JOINED_GAME:
      return {
        ...state,
        joinedGame: action.payload
      }
    case ACTIONS.SET_GAME_STATE:
      return {
        ...state,
        gameState: action.payload
      }
    case ACTIONS.SET_SERVER_PLAYER_STATE:
      return {
        ...state,
        serverPlayerState: action.payload
      }
    default:
      return state
  }
}

const initialState = {
  userName: `auto_${Math.random().toString(36).substring(2).toUpperCase()}`,
  joinedGame: null,
  gameState: null,
  serverPlayerState: null
}

const Store = ({ children }) => {
  const [state, dispatch] = useReducer(Reducer, initialState)

  useEffect(() => {
    SOCKET.on('update_game', (gameState) => {
      dispatch({ type: 'SET_GAME_STATE', payload: gameState })
    })

    SOCKET.on('update_player_state', (serverPlayerState) => {
      dispatch({ type: 'SET_SERVER_PLAYER_STATE', payload: serverPlayerState })
    })

    SOCKET.on('game_created', () => {
      SOCKET.emit('join_team', TEAM.SPECTATORS)
    })
  }, [])

  return (
    <Context.Provider value={{ state, dispatch }}>
      {children}
    </Context.Provider>
  )
}

const Context = createContext(initialState)

const App = () => {
  return (
    <BrowserRouter>
      <main className='app'>
        <Store>
          <Landing />
          <Route path='/game/:gameRoomCode' component={GameRoom} />
        </Store>
      </main>
    </BrowserRouter>
  )
}

const GameStateDisplay = () => {
  const { state } = useContext(Context)
  return (
    <div>
      <pre>Game state: {JSON.stringify(state.gameState, null, 2)}</pre>
      <pre>Player state: {JSON.stringify(state.serverPlayerState, null, 2)}</pre>
    </div>
  )
}

const GameControls = () => {
  const handleStartGame = (event) => {
    SOCKET.emit('start_game')
  }

  const handleBecomeCaller = (event) => {
    SOCKET.emit('become_caller')
  }

  const handleBecomeReceiver = (event) => {
    SOCKET.emit('become_receiver')
  }

  const handleJoinTeam = (team) => {
    return (event) => {
      SOCKET.emit('join_team', team)
    }
  }

  return (
    <div className='game-controls'>
      <button onClick={handleStartGame}>Start Game</button>
      <button onClick={handleBecomeCaller}>Become Caller</button>
      <button onClick={handleBecomeReceiver}>Become Receiver</button>
      {
        Object.keys(TEAM).map((team) => {
          return <button onClick={handleJoinTeam(team)}>Join {TEAM[team]}</button>
        })
      }
    </div>
  )
}

const GuessForm = (props) => {
  const { state } = useContext(Context)

  const { guessing, revealing } = props
  const revealingHintHistory = state.gameState.teams[revealing].public.hintHistory
  const hints = revealingHintHistory[revealingHintHistory.length - 1]

  const submitGuess = (event) => {
    event.preventDefault()
    SOCKET.emit('submit_guess', state.gameState.teams[state.serverPlayerState.team].private.activeGuess)
  }

  const handleSelect = (i) => {
    return (event) => {
      const newGuess = state.gameState.teams[state.serverPlayerState.team].private.activeGuess
      newGuess[i] = event.target.value
      SOCKET.emit('guess_changed', newGuess)
    }
  }

  if (state.serverPlayerState == null
    || state.serverPlayerState.team !== guessing
    || state.gameState.teams[state.serverPlayerState.team].private == null
    || (state.serverPlayerState.team === revealing && state.serverPlayerState.role !== GAME_ROLE.RECEIVER)) {
    return <span>{`Waiting for ${guessing} team to guess code for ${revealing} team`}</span>
  }

  return (
    <form id='guess-form' onSubmit={submitGuess}>
      {[0,1,2].map(i => {
        return (
          <>
          <label>Hint: {hints[i]}</label>
          <select value={state.gameState.teams[state.serverPlayerState.team].private.activeGuess[i]} onChange={handleSelect(i)}>
            {[1,2,3,4].map(choice => {
              return <option value={choice}>{choice}</option>
            })}
          </select>
          </>
        )
      })}
      <button>Submit</button>
    </form>
  )

}

const HintCreateForm = () => {
  const { state } = useContext(Context)

  const [hints, setHints] = useState(['', '', ''])

  const submitCreateHints = (event) => {
    event.preventDefault()
    SOCKET.emit('submit_hint', hints)
    setHints(['', '', ''])
  }

  if (state.serverPlayerState == null || state.serverPlayerState.team === TEAM.SPECTATORS || state.gameState.teams[state.serverPlayerState.team].private == null) {
    return <span>Waiting for callers to create hints...</span>
  }

  if (state.gameState.teams[state.serverPlayerState.team].private.activeHint.length > 0) {
    return <span>Waiting for the other team...</span>
  }

  return state.serverPlayerState.role === GAME_ROLE.CALLER
    ? (
    <form id='hint-create-form' onSubmit={submitCreateHints}>
      <input type='text' id='hint-one-input' name='hint-one-input' value={hints[0]} onChange={(event) => setHints([event.target.value, hints[1], hints[2]])} />
      <input type='text' id='hint-two-input' name='hint-two-input' value={hints[1]} onChange={(event) => setHints([hints[0], event.target.value, hints[2]])} />
      <input type='text' id='hint-three-input' name='hint-three-input' value={hints[2]} onChange={(event) => setHints([hints[0], hints[1], event.target.value])} />
      <button>Submit</button>
    </form>
    )
    : (<span>Waiting for hints from caller...</span>)
}

const StateControls = () => {
  const { state } = useContext(Context)

  const stateSwitch = {
    [GAME_STATE.GAME_INIT]: (''),
    [GAME_STATE.CREATE_HINTS]: (<HintCreateForm />),
    [GAME_STATE.RED_REVEAL_BLUE_GUESS]: (<GuessForm guessing={TEAM.BLUE} revealing={TEAM.RED}/>),
    [GAME_STATE.RED_REVEAL_RED_GUESS]: (<GuessForm guessing={TEAM.RED} revealing={TEAM.RED}/>),
    [GAME_STATE.BLUE_REVEAL_RED_GUESS]: (<GuessForm guessing={TEAM.RED} revealing={TEAM.BLUE}/>),
    [GAME_STATE.BLUE_REVEAL_BLUE_GUESS]: (<GuessForm guessing={TEAM.BLUE} revealing={TEAM.BLUE}/>),
    [GAME_STATE.ROUND_END]: (''),
    [GAME_STATE.TIE_BREAK]: (''),
    [GAME_STATE.GAME_END]: ('')
  }

  return (
    <div className='state-controls'>
      {stateSwitch[state.gameState.state]}
    </div>
  )
}

const GameDisplay = () => {
  return (
    <div className='game-display'>
      <GameControls />
      <StateControls />
      <GameStateDisplay />
    </div>
  )
}

const GameRoom = (props) => {
  const { state, dispatch } = useContext(Context)

  const gameRoomCode = props.match.params.gameRoomCode

  const handleCreateGame = (event) => {
    SOCKET.emit('create_game', state.joinedGame)
  }

  useEffect(() => {
    if (state.joinedGame === gameRoomCode) {
      return
    }
    SOCKET.emit('join_game', gameRoomCode)
    dispatch({ type: 'SET_JOINED_GAME', payload: gameRoomCode })
  }, [state.joinedGame, gameRoomCode, dispatch])

  return (
    <section>
      <div>Joined room: {gameRoomCode}</div>
      {
        state.gameState == null
          ? <p>Game doesn't exist yet. Create one? <button onClick={handleCreateGame}>Create</button></p>
          : <GameDisplay />
      }
    </section>
  )
}

const Landing = withRouter(({ history }) => {
  const { state, dispatch } = useContext(Context)

  const [nameInputValue, setNameInputValue] = useState('')

  const [gameRoomCodeValue, setGameRoomCodeValue] = useState('')

  useEffect(() => {
    SOCKET.emit('set_name', state.userName)
  }, [state.userName])

  const submitChangeName = (event) => {
    event.preventDefault()
    dispatch({ type: 'SET_NAME', payload: nameInputValue })
    setNameInputValue('')
  }

  const submitRoomJoin = (event) => {
    event.preventDefault()
    history.push(`/game/${gameRoomCodeValue}`)
    setGameRoomCodeValue('')
  }

  return (
    <section>
      <p>Hello {state.userName} - Welcome to Code Breaker!</p>
      <form id='name-change-form' onSubmit={submitChangeName}>
        <label for='name-change-input'>Change name:</label>
        <input type='text' id='name-change-input' name='name-change-input' value={nameInputValue} onChange={(event) => setNameInputValue(event.target.value)} />
        <button>Change</button>
      </form>
      <form id='join-room-form' onSubmit={submitRoomJoin}>
        <label for='join-room-code-input'>Join a game:</label>
        <input type='text' id='join-room-code-input' name='join-room-code-input' value={gameRoomCodeValue} onChange={(event) => setGameRoomCodeValue(event.target.value)} />
        <button>Join</button>
      </form>
    </section>
  )
})

export default App
