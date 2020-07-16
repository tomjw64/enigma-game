import React, { createContext, useReducer, useState, useContext, useEffect } from 'react'
import io from 'socket.io-client'
import { flatten, zip } from 'lodash'
import styled from 'styled-components'
import Spinner from 'react-spinkit'
import { BrowserRouter, Route, withRouter } from 'react-router-dom'
import { toEnum } from '../shared/utils'
import { TEAM } from '../shared/team'
import { GAME_STATE } from '../shared/game-state'
import { GAME_ROLE } from '../shared/game-role'

const COLOR = {
  RED_TEAM: '#961b28',
  BLUE_TEAM: '#2862a4',
  DARK: '#262626',
  DARK_PALE: '#363636',
  LIGHT: '#eeeeee', 
  ACCENT: '#fdca40',
}
const TEAM_TO_COLOR = {
  [TEAM.RED]: COLOR.RED_TEAM,
  [TEAM.BLUE]: COLOR.BLUE_TEAM,
  [TEAM.SPECTATORS]: COLOR.ACCENT
}
const TEAM_TO_COLOR_CONTRAST = {
  [TEAM.RED]: COLOR.LIGHT,
  [TEAM.BLUE]: COLOR.LIGHT,
  [TEAM.SPECTATORS]: COLOR.DARK
}

const VIEWPORT_WIDTH = {
  SMALL: '768px'
}

const SOCKET = io()

const ACTIONS = toEnum([
  'SET_NAME',
  'SET_JOINED_GAME',
  'SET_GAME_STATE',
])

const Reducer = (state, action) => {
  switch (action.type) {
    case ACTIONS.SET_NAME:
      return {
        ...state,
        username: action.payload
      }
    case ACTIONS.SET_JOINED_GAME:
      return {
        ...state,
        joinedGameCode: action.payload
      }
    case ACTIONS.SET_GAME_STATE:
      return {
        ...state,
        gameState: action.payload
      }
    default:
      return state
  }
}

const initialState = {
  username: `auto_${Math.random().toString(36).substring(2).toUpperCase()}`,
  joinedGameCodeCode: null,
  gameState: null,
}

const Store = ({ children }) => {
  const [state, dispatch] = useReducer(Reducer, initialState)

  useEffect(() => {
    SOCKET.on('update_game', (gameState) => {
      dispatch({ type: 'SET_GAME_STATE', payload: gameState })
    })

    SOCKET.on('game_created', () => {
      SOCKET.emit('set_role', TEAM.SPECTATORS, GAME_ROLE.RECEIVER)
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
      <div id='app' style={{position: 'relative'}}>
        <Store>
          <Landing />
          <Route path='/game/:gameRoomCode' component={GameRoom} />
        </Store>
      </div>
    </BrowserRouter>
  )
}

const GameStateDisplay = () => {
  const { state } = useContext(Context)
  return (
    <div>
      <pre>Game state: {JSON.stringify(state.gameState, null, 2)}</pre>
    </div>
  )
}

const RoleInfo = styled.div`
  display: flex;
  border: 1px solid ${COLOR.LIGHT};
  flex-grow: 1;
`
const RoleMemberList = styled.p`
  margin: 0.2em 0.5em;
  flex-grow: 1;
  font-weight: bold;
  min-width: 4rem;
`

const RoleSelectControlsWrapper = styled.div`
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
`

const RoleSelectControls = () => {
  const { state } = useContext(Context)

  const handleSetRole = (team, role) => {
    return (event) => {
      SOCKET.emit('set_role', team, role)
    }
  }

  const roleMembers = (team, role) => {
    const teamInfo = state.gameState.teams[team]
    return {
      [GAME_ROLE.CALLER]: teamInfo.caller == null ? [] : [teamInfo.caller],
      [GAME_ROLE.RECEIVER]: teamInfo.receivers
    }[role]
  }

  return (
    <RoleSelectControlsWrapper>
      {
        flatten([TEAM.RED, TEAM.BLUE].map(team => {
          return [GAME_ROLE.CALLER, GAME_ROLE.RECEIVER].map(role => {
            return (
              <RoleInfo>
                <InlineButton onClick={handleSetRole(team, role)}>{team} {role}</InlineButton>
                <RoleMemberList><span>{roleMembers(team, role).join(', ')}</span></RoleMemberList>
              </RoleInfo>
            )
          })
        }))
      }
      <RoleInfo>
        <InlineButton onClick={handleSetRole(TEAM.SPECTATORS, GAME_ROLE.RECEIVER)}>SPECTATOR</InlineButton>
        <RoleMemberList>{roleMembers(TEAM.SPECTATORS, GAME_ROLE.CALLER).concat(roleMembers(TEAM.SPECTATORS, GAME_ROLE.RECEIVER)).join(', ')}</RoleMemberList>
      </RoleInfo>
    </RoleSelectControlsWrapper>
  )
}

const GuessFormInner = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
`

const HintSelector = styled.div`
  margin: 0.5rem;
  label {
    margin-right: 0.3rem;
  }
  select {
    align-self: stretch;
  }
`

const GuessForm = (props) => {
  const { state } = useContext(Context)

  const { revealing } = props
  const myTeam = state.gameState.me.team
  const myRole = state.gameState.me.role
  const activeGuess = state.gameState.teams[myTeam].activeGuess
  const activeHint = state.gameState.teams[revealing].activeHint

  const submitGuess = (event) => {
    event.preventDefault()
    SOCKET.emit('guess_submit')
  }

  const handleSelect = (i) => {
    return (event) => {
      const newGuess = [...activeGuess]
      newGuess[i] = event.target.value
      SOCKET.emit('guess_change', newGuess)
    }
  }

  if (myTeam === TEAM.SPECTATORS || state.gameState.teams[myTeam].activeGuessSubmitted || (revealing === myTeam && myRole === GAME_ROLE.CALLER)) {
    return <span>Waiting for {[TEAM.RED, TEAM.BLUE].filter(team => !state.gameState.teams[team].activeGuessSubmitted).join(', ')} team(s) to guess code for {revealing} team</span>
  }

  return (
    <>
    <span>Guessing for {revealing} team:</span>
    <form id='guess-form' onSubmit={submitGuess}>
      <GuessFormInner>
        {[0,1,2].map(i => {
          return (
            <HintSelector>
            <label>Hint: {activeHint[i]}</label>
            <select value={activeGuess[i]} onChange={handleSelect(i)}>
              {[1,2,3,4].map(choice => {
                return <option value={choice}>{choice}</option>
              })}
            </select>
            </HintSelector>
          )
        })}
      </GuessFormInner>
      <button>Submit</button>
    </form>
    </>
  )
}

const TieBreakGuessForm = () => {
  const { state } = useContext(Context)

  const myTeam = state.gameState.me.team

  const tieBreakGuess = state.gameState.teams[myTeam].tieBreakGuess

  if (myTeam === TEAM.SPECTATORS || state.gameState.teams[myTeam].tieBreakGuessSubmitted) {
    return <span>Waiting for {[TEAM.RED, TEAM.BLUE].filter(team => !state.gameState.teams[team].tieBreakGuessSubmitted).join(', ')} team(s) to guess secret words</span>
  }

  const submitTieBreakGuess = (event) => {
    event.preventDefault()
    SOCKET.emit('tiebreak_submit')
  }

  const handleChange = (i) => {
    return (event) => {
      const newGuess = [...tieBreakGuess]
      newGuess[i] = event.target.value
      SOCKET.emit('tiebreak_change', newGuess)
    }
  }

  return (
    <form id='tie-break-guess-form' onSubmit={submitTieBreakGuess}>
      {[0,1,2,3].map(i => {
        return (
          <input type='text' value={tieBreakGuess[i]} onChange={handleChange(i)} />
        )
      })}
      <button>Submit</button>
    </form>
  )
}

const GameInitForm = () => {
  const handleStartGame = (event) => {
    SOCKET.emit('start_game')
  }

  return <button onClick={handleStartGame}>Start Game</button>
}

const HintCreateForm = () => {
  const { state } = useContext(Context)

  const myTeam = state.gameState.me.team
  const myRole = state.gameState.me.role

  const [hints, setHints] = useState(['', '', ''])

  const submitCreateHints = (event) => {
    event.preventDefault()
    SOCKET.emit('hint_submit', hints)
    setHints(['', '', ''])
  }


  if (myTeam === TEAM.SPECTATORS || myRole === GAME_ROLE.RECEIVER || state.gameState.teams[myTeam].activeHintSubmitted) {
    return (
      <>
        <p>Waiting for callers to create hints</p>
        <div style={{display: 'flex'}}>
          {
            [TEAM.RED, TEAM.BLUE].map(team => {
              return (
                <div style={{
                  margin: '0 1em',
                  opacity: state.gameState.teams[team].activeHintSubmitted ? "0" : "1",
                  transition: 'opacity 1s'
                }}>
                  <Spinner
                    name="ball-grid-pulse"
                    color={TEAM_TO_COLOR[team]}
                  />
                </div>
              )
            })
          }
        </div>
      </>
    )
  }

  return (
    <>
    <div id='active-card'>
      <p style={{fontSize: '1.5rem', color: COLOR.LIGHT, margin: '0.5em'}}>
        Code Sequence: [{state.gameState.teams[myTeam].activeCard.join(', ')}]
      </p>
    </div>
    <form id='hint-create-form' onSubmit={submitCreateHints}>
      <div>
        <input type='text' id='hint-one-input' value={hints[0]} onChange={(event) => setHints([event.target.value, hints[1], hints[2]])} />
        <input type='text' id='hint-two-input' value={hints[1]} onChange={(event) => setHints([hints[0], event.target.value, hints[2]])} />
        <input type='text' id='hint-three-input' value={hints[2]} onChange={(event) => setHints([hints[0], hints[1], event.target.value])} />
      </div>
      <button>Submit</button>
    </form>
    </>
  )
}

const StateControls = () => {
  const { state } = useContext(Context)

  const team = state?.gameState?.me?.team

  const otherTeam = {
    [TEAM.BLUE]: TEAM.RED,
    [TEAM.RED]: TEAM.BLUE
  }

  const stateSwitchInfo = {
    [GAME_STATE.GAME_INIT]: (<TeamWords team={team}/>),
    [GAME_STATE.CREATE_HINTS]: (<TeamWords team={team}/>),
    [GAME_STATE.RED_REVEAL]: (<TeamWords team={TEAM.RED}/>),
    [GAME_STATE.BLUE_REVEAL]: (<TeamWords team={TEAM.BLUE}/>),
    [GAME_STATE.ROUND_END]: null,
    [GAME_STATE.TIE_BREAK]: ((team === TEAM.SPECTATORS || team == null)
                            ? <><TeamWords team={TEAM.RED} /><TeamWords team={TEAM.BLUE}/></>
                            : <TeamWords team={otherTeam[team]} />),
    [GAME_STATE.GAME_END]: (<><TeamWords team={TEAM.RED} /><TeamWords team={TEAM.BLUE}/></>)
  }

  const stateSwitchAction = {
    [GAME_STATE.GAME_INIT]: (<GameInitForm />),
    [GAME_STATE.CREATE_HINTS]: (<HintCreateForm />),
    [GAME_STATE.RED_REVEAL]: (<GuessForm revealing={TEAM.RED}/>),
    [GAME_STATE.BLUE_REVEAL]: (<GuessForm revealing={TEAM.BLUE}/>),
    [GAME_STATE.ROUND_END]: null,
    [GAME_STATE.TIE_BREAK]: (<TieBreakGuessForm />),
    [GAME_STATE.GAME_END]: (<><p>Winner: {state?.gameState?.winner?.team}</p><p>Reason: {state?.gameState?.winner?.reason}</p></>)
  }

  return (
    <div id='state-controls' style={{padding: '1rem'}}>
      {stateSwitchInfo[state.gameState.state]}
      <CurrentActionCard>
        {stateSwitchAction[state.gameState.state]}
      </CurrentActionCard>
    </div>
  )
}

const TeamWord = styled.p`
  font-size: 1.2rem;
  flex-grow: 1;
  border: 2px solid ${COLOR.LIGHT};
  text-align: center;
  margin: 0;
  white-space: nowrap;
  padding: 0.5em;
`

const TeamWordsTitle = styled.p`
  font-size: 1.5rem;
  color: ${COLOR.LIGHT};
  margin: 0.5em;
`

const TeamWordWrapper = styled.div`
  display: flex;
  flex-wrap: wrap;
`

const TeamWords = (props) => {
  const shownTeam = props.team

  const { state } = useContext(Context)

  const myTeam = state.gameState.me.team

  if (shownTeam === myTeam || state?.gameState?.teams[shownTeam]?.targetWords != null) {
    return (
      <div className='team-words-known'>
        <TeamWordsTitle>My Team Words</TeamWordsTitle>
        <TeamWordWrapper>
        {
          (state?.gameState?.teams[shownTeam]?.targetWords || ['?', '?', '?', '?']).map((word, i) => {
            return <TeamWord>{word === '?' ? '' : `${i+1}. `}{word}</TeamWord>
          })
        }
        </TeamWordWrapper>
      </div>
    )
  } else {
    const hintHistory = state.gameState.teams[shownTeam].hintHistory
    const cardHistory = state.gameState.teams[shownTeam].cardHistory

    if (hintHistory.length !== cardHistory.length + 1 && hintHistory.length !== cardHistory.length) {
      throw new Error(`Game out of sync! Hint history length: ${hintHistory.length}, Card history length: ${cardHistory.length}`)
    }
    const hintsForNumbers = {
      '1': [], '2': [], '3': [], '4': []
    }
    for (const [card, hint] of zip(cardHistory, hintHistory)) {
      if (card == null || hint == null) {
        break
      }
      for (const i of [0,1,2]) {
        hintsForNumbers[card[i]].push(hint[i])
      }
    }

    return (
      <div className='team-words-unknown'>
        <TeamWordsTitle>{shownTeam} Team Past Hints</TeamWordsTitle>
        <TeamWordWrapper>
          {
            Object.entries(hintsForNumbers).map(([key, values]) => {
              return <TeamWord>{key}: {values.length > 0 ? values.join(', ') : '?'}</TeamWord>
            })
          }
        </TeamWordWrapper>
      </div>
    )
  }
}

const ScoreboardWrapper = styled.aside`
  background-color: ${COLOR.DARK};
  font-size: 1.5rem;
`

const ScoreboardSection = styled.div`
  display: flex;
  align-items: center;
`

const ScoreboardSectionTitle = styled.p`
  margin: 0.2em 0.5em;
`

const TeamColored = styled.span`
  color: ${props => TEAM_TO_COLOR[props.team] || COLOR.ACCENT};
  margin: 0 0.5em;
`

const Scoreboard = () => {
  const { state } = useContext(Context)
  return (
    <ScoreboardWrapper id='scoreboard'>
      <ScoreboardSection>
        <ScoreboardSectionTitle>Self Codes Incorrect:</ScoreboardSectionTitle>
        {
          [TEAM.RED, TEAM.BLUE].map(team => {
            console.log(state.gameState)
            return <TeamColored team={team}>{state.gameState.teams[team].errorCount}</TeamColored>
          })
        }
      </ScoreboardSection>
      <ScoreboardSection>
        <ScoreboardSectionTitle>Rival Codes Cracked:</ScoreboardSectionTitle>
        {
          [TEAM.RED, TEAM.BLUE].map(team => {
            return <TeamColored team={team}>{state.gameState.teams[team].crackedCount}</TeamColored>
          })
        }
      </ScoreboardSection>
    </ScoreboardWrapper>
  )
}

const GameDisplayInner = styled.section`
  background: ${COLOR.DARK_PALE};
  color: ${COLOR.LIGHT};
  display: flex;
  flex-direction: column;
`

const CurrentActionCard = styled.div`
  font-size: 1.5rem;
  color: ${COLOR.LIGHT};
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;

  span, p {
    margin: 0.5em 0;
  }
  button {
    font-size: inherit;
    background: ${COLOR.ACCENT};
    cursor: pointer;
    border: none;
    padding: 0.2em 0.5em;
    margin: 0.2em 0.5em;
    color: ${COLOR.DARK};
    min-width: 3em;
  }
  form {
    margin: 0.3em 0.3em;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
    flex-direction: column;

    input {
      margin: 0.5rem;
    }
  }
`

const SimpleFlexExpand = styled.div`
  flex-grow: 1;
`

const GameDisplay = () => {
  const { state } = useContext(Context)

  const handleCreateGame = (event) => {
    SOCKET.emit('create_game', state.joinedGameCode)
  }


  return (
    <GameDisplayInner id='game-display'>
      {
        state.gameState == null
          ? (
            <CurrentActionCard>
              <p>Game doesn't exist yet.</p>
              <button onClick={handleCreateGame}>Create</button>
            </CurrentActionCard>
          )
          : (
            <>
            <RoleSelectControls />
            <SimpleFlexExpand>
              <StateControls />
            </SimpleFlexExpand>
            <Scoreboard />
            </>
          )
      }
    </GameDisplayInner>
  )
}

const GameInfo = styled.section`
  background: ${props => TEAM_TO_COLOR[props.team] || COLOR.ACCENT};
  border-bottom: 2px solid ${COLOR.DARK};
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  color: ${props => TEAM_TO_COLOR_CONTRAST[props.team] || COLOR.DARK};
  font-size: 1rem;
`

const GameRoom = (props) => {
  const { state, dispatch } = useContext(Context)

  const gameRoomCode = props.match.params.gameRoomCode

  useEffect(() => {
    if (state.joinedGameCode === gameRoomCode) {
      return
    }
    SOCKET.emit('join_game', gameRoomCode)
    dispatch({ type: 'SET_JOINED_GAME', payload: gameRoomCode })
  }, [state.joinedGameCode, gameRoomCode, dispatch])

  const team = state?.gameState?.me?.team
  const role = state?.gameState?.me?.role
  return (
    <main>
    <GameInfo team={team}>
      <p>Joined game: <span style={{fontWeight: 'bold'}}>{gameRoomCode}</span></p>
      {
        (team == null || role == null)
        ? null
        : (<p><span style={{fontWeight: 'bold'}}>{team === TEAM.SPECTATORS ? "SPECTATOR" : `${team} ${role}`}</span></p>)
      }
    </GameInfo>
    <GameDisplay />
    </main>
  )
}
const Header = styled.header`
  max-height: 100vh;
  transition: max-height 0.6s ease-in-out 0s;

  @media (max-width: ${VIEWPORT_WIDTH.SMALL}) {
    &.hide {
      max-height: 0;
    }
  }
`

const HeaderContents = styled.div`
  display: flex;
  background: ${COLOR.DARK};
  align-items: center;
  padding: 1rem 3rem;
  flex-wrap: wrap;
  color: ${COLOR.LIGHT};
  justify-content: space-evenly;
  font-size: 1rem;
`

const HeaderInlineFormInputContainer = styled.div`
  background: ${COLOR.LIGHT};
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  margin: 0 0.5em;
  height: 1.8em;
`

const HeaderInlineForm = styled.form`
  margin: 0.3em 0.3em;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
`

const HeaderInlineFormLabel = styled.label`
  color: ${COLOR.LIGHT};
  margin: 0.2em 0.5em;
`

const HeaderInlineFormInput = styled.input`
  color: ${COLOR.DARK};
  background: none;
  border: none;
  padding-left: 0.5em;
  height: 100%;
`

const InlineButton = styled.button`
  background: ${COLOR.ACCENT};
  cursor: pointer;
  border: none;
  padding: 0.2em 0.5em;
  color: ${COLOR.DARK};
  min-width: 3em;
`

const HeaderToggle = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  cursor: pointer;
  height: 2.5rem;
  width: 2.5rem;
  visibility: hidden;
  z-index: 100;
  mask: url(/more-vertical.svg) no-repeat 50% 50%;
  transition: background-color 1s ease 0s;

  @media (max-width: ${VIEWPORT_WIDTH.SMALL}) {
    &.visible {
      visibility: visible;
    }
  }
`

const Landing = withRouter(({ history }) => {
  const { state, dispatch } = useContext(Context)

  const [nameInputValue, setNameInputValue] = useState(state.username)

  const [gameRoomCodeValue, setGameRoomCodeValue] = useState('')

  const [hideHeader, setHideHeader] = useState(true)

  useEffect(() => {
    SOCKET.emit('set_name', state.username)
  }, [state.username])

  const submitChangeName = (event) => {
    event.preventDefault()
    dispatch({ type: 'SET_NAME', payload: nameInputValue })
  }

  const submitRoomJoin = (event) => {
    event.preventDefault()
    history.push(`/game/${gameRoomCodeValue}`)
    setGameRoomCodeValue('')
  }

  const lockHeaderVisible = state.gameState == null
  const headerHidden = (hideHeader && !lockHeaderVisible)

  const team = state?.gameState?.me?.team

  return (
    <>
    <Header className={headerHidden ? 'hide' : ''}>
      <HeaderContents>
        <HeaderInlineForm id='name-change-form' onSubmit={submitChangeName}>
          <HeaderInlineFormLabel for='name-change-input'>Welcome to Enigma, Agent</HeaderInlineFormLabel>
          <HeaderInlineFormInputContainer>
            <HeaderInlineFormInput type='text' id='name-change-input' value={nameInputValue} onChange={(event) => setNameInputValue(event.target.value)} />
            <InlineButton style={{height: '100%'}}>{'>>'}</InlineButton>
          </HeaderInlineFormInputContainer>
        </HeaderInlineForm>
        <HeaderInlineForm id='join-room-form' onSubmit={submitRoomJoin}>
          <HeaderInlineFormLabel for='join-room-code-input'>Join a game:</HeaderInlineFormLabel>
          <HeaderInlineFormInputContainer>
            <HeaderInlineFormInput type='text' id='join-room-code-input' value={gameRoomCodeValue} onChange={(event) => setGameRoomCodeValue(event.target.value)} />
            <InlineButton style={{height: '100%'}}>Join</InlineButton>
          </HeaderInlineFormInputContainer>
        </HeaderInlineForm>
      </HeaderContents>
    </Header>
    <HeaderToggle className={lockHeaderVisible ? '' : 'visible'} style={{backgroundColor: headerHidden ? (TEAM_TO_COLOR_CONTRAST[team] || COLOR.DARK) : COLOR.ACCENT}} onClick={(event) => setHideHeader(!hideHeader)}/>
    </>
  )
})

export default App
