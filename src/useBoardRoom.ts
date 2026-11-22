import { useEffect, useRef, useState } from 'react'
import { BoardSession, emptyBoard, isPeerMessage } from './board'
import type { PeerMessage } from './board'
import type { PeerInfo } from './transport/signalingTypes'
import { usePeerRoom } from './transport/usePeerRoom'

type Session = {
  board: BoardSession
  ready: boolean
  request?: { peerId: string; id: string }
  attempted: Set<string>
}

export function useBoardRoom() {
  const session = useRef<Session | null>(null)
  const [board, setBoard] = useState<BoardSession>()
  const [state, setState] = useState(emptyBoard)
  const [roomCode, setRoomCode] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState('')
  const [retry, setRetry] = useState(0)

  function onMessage(message: PeerMessage, peer: PeerInfo) {
    const active = session.current
    if (!active) return
    try {
      if (message.type === 'board.snapshot') {
        if (active.request?.peerId !== peer.peerId || active.request.id !== message.payload.requestId) return
        active.board.receive(message)
        active.ready = true
        active.request = undefined
        setSyncing(false)
        setActivity('Quadro inicial recebido de ' + peer.nickname + '.')
        return
      }
      if (!active.board.receive(message)) return
      if (message.type === 'stroke.start') setActivity(peer.nickname + ' começou a desenhar.')
      if (message.type === 'sticky.upsert') setActivity(peer.nickname + ' atualizou um post-it.')
      if (message.type === 'object.delete') setActivity(peer.nickname + ' removeu um item.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao aplicar uma alteração recebida.')
    }
  }

  const transport = usePeerRoom({ isPeerMessage, onMessage })
  const { self, peers, snapshotProviderId, openDataChannels, sendToPeer, broadcast } = transport
  const peerId = self?.peerId
  const nickname = self?.nickname
  const connected = openDataChannels.map(peer => peer.peerId)

  useEffect(() => {
    if (!peerId || !nickname) {
      session.current = null
      setBoard(undefined)
      setState(emptyBoard())
      setSyncing(false)
      return
    }
    const board = new BoardSession(peerId, nickname, (message, target) => {
      if (target) {
        if (!sendToPeer(target, message)) throw new Error('Conexão P2P indisponível.')
      } else {
        broadcast(message)
      }
    }, setState)
    session.current = { board, ready: false, attempted: new Set() }
    setBoard(board)
  }, [peerId, nickname, sendToPeer, broadcast])

  useEffect(() => {
    const active = session.current
    if (!active || active.ready) return
    const provider = peers.find(peer => peer.peerId === snapshotProviderId && !active.attempted.has(peer.peerId))
      ?? peers.find(peer => !active.attempted.has(peer.peerId))

    if (!provider) {
      active.ready = true
      setSyncing(false)
      if (peers.length) setError('Não foi possível receber o quadro inicial.')
      return
    }

    setSyncing(true)
    const id = provider.peerId
    if (openDataChannels.some(peer => peer.peerId === id) && active.request?.peerId !== id) {
      const requestId = id + ':' + Date.now()
      active.request = { peerId: id, id: requestId }
      try {
        active.board.requestSnapshot(id, requestId)
      } catch {
        active.attempted.add(id)
        active.request = undefined
        setRetry(value => value + 1)
        return
      }
    }
    const timer = window.setTimeout(() => {
      if (session.current !== active || active.ready) return
      active.attempted.add(id)
      active.request = undefined
      setRetry(value => value + 1)
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [peerId, peers, snapshotProviderId, openDataChannels, retry])

  async function join(code: string, nickname: string) {
    const normalized = code.trim().toUpperCase()
    setError('')
    setActivity('')
    try {
      await transport.joinRoom(normalized, nickname.trim())
      setRoomCode(normalized)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar na sala.')
    }
  }

  function leave() {
    transport.leaveRoom()
    setRoomCode('')
    setActivity('')
    setError('')
  }

  return {
    join, leave, state, roomCode: transport.joined ? roomCode : '', peers, connected,
    joining: transport.joining, syncing: syncing || !board,
    error: error || transport.error?.message || '', setError, activity, board,
  }
}
