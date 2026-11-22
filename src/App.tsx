import { useRef, useState } from 'react'
import type { FormEvent, PointerEvent } from 'react'
import { colors } from './board'
import type { NoteColor, Point, StickyNote } from './board'
import { useBoardRoom } from './useBoardRoom'

const colorNames: Record<NoteColor, string> = {
  yellow: 'Amarelo', blue: 'Azul', pink: 'Rosa', green: 'Verde',
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))
type Tool = 'draw' | 'erase' | 'note' | 'move'
type Draft = Point & { id?: string; text: string; color: NoteColor }
type Drawing = { id: string; pointer: number; last: Point; queue: Point[]; frame: number }

export default function App() {
  const room = useBoardRoom()
  const [nickname, setNickname] = useState('')
  const [code, setCode] = useState('')
  const [tool, setTool] = useState<Tool>('draw')
  const [ink, setInk] = useState('#182d29')
  const [width, setWidth] = useState(4)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const drawing = useRef<Drawing | null>(null)
  const { board } = room

  function act(action: () => void) {
    try {
      room.setError('')
      action()
      return true
    } catch (cause) {
      room.setError(cause instanceof Error ? cause.message : 'Não foi possível aplicar a alteração.')
      return false
    }
  }

  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!nickname.trim() || !code.trim()) {
      room.setError('Preencha o apelido e o código da sala.')
      return
    }
    void room.join(code, nickname)
  }

  function cursor(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.round(clamp((event.clientX - rect.left) / rect.width) * 10000) / 10000,
      y: Math.round(clamp((event.clientY - rect.top) / rect.height) * 10000) / 10000,
    }
  }

  function flush(current: Drawing) {
    if (!board || !current.queue.length) return
    if (!act(() => board.points(current.id, current.queue.splice(0, 128)))) {
      current.queue = []
      try { board.end(current.id) } finally { drawing.current = null }
    }
  }

  function finish(pointer?: number) {
    const current = drawing.current
    if (!current || (pointer !== undefined && current.pointer !== pointer)) return
    cancelAnimationFrame(current.frame)
    flush(current)
    if (drawing.current) act(() => board?.end(current.id))
    drawing.current = null
  }

  function down(event: PointerEvent<SVGSVGElement>) {
    if (!board || room.syncing || event.button !== 0 || drawing.current || draft) return
    const point = cursor(event)
    if (tool === 'note') {
      setDraft({ ...point, text: '', color: 'yellow' })
      return
    }
    if (tool === 'move') {
      const item = moving ? board.state.stickies[moving] : undefined
      if (item) act(() => board.save({ ...item, ...point }, item.id))
      setMoving(null)
      setTool('draw')
      return
    }
    if (tool !== 'draw') return
    act(() => {
      const id = board.start(point, ink, width)
      event.currentTarget.setPointerCapture(event.pointerId)
      drawing.current = { id, pointer: event.pointerId, last: point, queue: [], frame: 0 }
    })
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const current = drawing.current
    if (!current || current.pointer !== event.pointerId) return
    const point = cursor(event)
    if (point.x === current.last.x && point.y === current.last.y) return
    current.last = point
    current.queue.push(point)
    if (current.queue.length === 128) flush(current)
    if (drawing.current && !current.frame) {
      current.frame = requestAnimationFrame(() => {
        current.frame = 0
        if (drawing.current === current) flush(current)
      })
    }
  }

  function edit(note: StickyNote) {
    if (room.syncing) return
    if (tool === 'erase') {
      act(() => board?.delete(note.id))
      return
    }
    const { id, x, y, text, color } = note
    setDraft({ id, x, y, text, color })
  }

  function authorLabel(creatorName?: string, peerId?: string) {
    const name = creatorName || room.peers.find(peer => peer.peerId === peerId)?.nickname
    return name ? 'Criado por ' + name : 'Autor indisponível'
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || !board) return
    const { id, ...note } = draft
    if (act(() => board.save(note, id))) setDraft(null)
  }

  if (!room.roomCode) return (
    <main className="entry-board">
      <section className="entry yellow" aria-labelledby="entry-title">
        <h1 id="entry-title">Entre no quadro</h1>
        <p>Use o mesmo código de sala que os outros participantes.</p>
        <form onSubmit={join}>
          <label>Apelido<input required maxLength={24} value={nickname} onChange={event => setNickname(event.target.value)} /></label>
          <label>Código da sala<input required maxLength={32} value={code} onChange={event => setCode(event.target.value)} /></label>
          <button className="primary" disabled={room.joining}>{room.joining ? 'Entrando…' : 'Entrar na sala'}</button>
        </form>
        {room.error && <p role="alert" className="error">{room.error}</p>}
      </section>
    </main>
  )

  return (
    <main className="workspace">
      <section className="board" aria-label="Quadro compartilhado">
        <svg aria-label="Área de desenho" className={'surface ' + tool} viewBox="0 0 1000 1000"
          preserveAspectRatio="none" onPointerDown={down} onPointerMove={move}
          onPointerUp={event => finish(event.pointerId)} onPointerCancel={event => finish(event.pointerId)}
          onLostPointerCapture={event => finish(event.pointerId)}>
          {Object.values(room.state.strokes).map(stroke => {
            const path = stroke.points.map(({ x, y }, index) => (index === 0 ? 'M' : 'L') + (x * 1000) + ' ' + (y * 1000)).join(' ')
            const first = stroke.points[0]
            const dot = stroke.points.length === 1 ? ' l 0.01 0' : ''
            return <path key={stroke.id} d={first ? path + dot : ''} fill="none" stroke={stroke.color}
              strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
              onPointerDown={event => {
                if (tool !== 'erase' || room.syncing || event.button !== 0) return
                event.stopPropagation()
                act(() => board?.delete(stroke.id))
              }}>
              <title>{authorLabel(stroke.creatorName, stroke.createdBy)}</title>
            </path>
          })}
        </svg>
        {Object.values(room.state.stickies).map(note => (
          <button className={'sticky ' + note.color} key={note.id} onClick={() => edit(note)}
            title={authorLabel(note.creatorName, note.id.slice(0, note.id.lastIndexOf(':')))}
            aria-label={(tool === 'erase' ? 'Apagar post-it: ' : 'Editar post-it: ') + note.text}
            style={{ left: note.x * 100 + '%', top: note.y * 100 + '%',
              transform: 'translate(' + -note.x * 100 + '%, ' + -note.y * 100 + '%)' }}>
            {note.text}
          </button>
        ))}
      </section>
      <div className="board-tools" role="group" aria-label="Ferramentas do quadro">
        <button aria-label="Desenhar" title="Desenhar" aria-pressed={tool === 'draw'} disabled={room.syncing}
          onClick={() => { setTool('draw'); setMoving(null) }}>
          <ToolIcon name="draw" />
        </button>
        {tool === 'draw' && (
          <div className="draw-options">
            <input type="color" aria-label="Cor do traço" title="Cor do traço" value={ink}
              disabled={room.syncing} onChange={event => setInk(event.target.value)} />
            <input type="range" aria-label="Espessura do traço" title="Espessura do traço" min={1} max={24} value={width}
              disabled={room.syncing} onChange={event => setWidth(Number(event.target.value))} />
          </div>
        )}
        <button aria-label="Post-it" title="Post-it" aria-pressed={tool === 'note'} disabled={room.syncing}
          onClick={() => { setTool('note'); setMoving(null) }}>
          <ToolIcon name="note" />
        </button>
        <button aria-label="Borracha" title="Borracha" aria-pressed={tool === 'erase'} disabled={room.syncing}
          onClick={() => { setTool('erase'); setMoving(null) }}>
          <ToolIcon name="erase" />
        </button>
        <details className="room-info">
          <summary aria-label="Informações" title="Informações"><ToolIcon name="info" /></summary>
          <div className="room-info-card">
            <h2>Sala {room.roomCode}</h2>
            <ul aria-label="Membros da sala">
              <li>{nickname.trim()} (você)</li>
              {room.peers.map(peer => <li key={peer.peerId}>{peer.nickname}</li>)}
            </ul>
          </div>
        </details>
        <button aria-label="Sair" title="Sair"
          onClick={() => { finish(); setDraft(null); setMoving(null); setTool('draw'); room.leave() }}>
          <ToolIcon name="exit" />
        </button>
      </div>
      {(room.error || room.syncing || tool === 'move' || tool === 'note') && (
        <p className="board-message" role={room.error ? 'alert' : 'status'}>
          {room.error || (room.syncing ? 'Recebendo o quadro…' : tool === 'move'
            ? 'Clique no quadro para escolher a nova posição.' : 'Clique no quadro para posicionar o post-it.')}
        </p>
      )}
      {draft && <div className="overlay">
        <form className="editor" role="dialog" aria-modal="true" aria-label="Editar post-it" onSubmit={save}
          onKeyDown={event => { if (event.key === 'Escape') setDraft(null) }}>
          <h2>{draft.id ? 'Editar post-it' : 'Novo post-it'}</h2>
          <label>Texto<textarea autoFocus required maxLength={500} rows={5} value={draft.text}
            onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
          <label>Cor<select value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value as NoteColor })}>
            {colors.map(color => <option key={color} value={color}>{colorNames[color]}</option>)}
          </select></label>
          {room.error && <p className="error" role="alert">{room.error}</p>}
          <div className="tools">
            <button className="primary">Salvar</button>
            <button type="button" onClick={() => setDraft(null)}>Cancelar</button>
            {draft.id && <button type="button" onClick={() => { setMoving(draft.id ?? null); setDraft(null); setTool('move') }}>Mover</button>}
            {draft.id && <button type="button" onClick={() => {
              const id = draft.id
              if (id && act(() => board?.delete(id))) setDraft(null)
            }}>Excluir</button>}
          </div>
        </form>
      </div>}
    </main>
  )
}

const toolPaths = {
  draw: 'M4 20l4.5-1 11-11a2 2 0 0 0-3-3l-11 11L4 20Zm10-13 3 3',
  note: 'M14 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8l-6 6Zm0 0v-4a2 2 0 0 1 2-2h4',
  erase: 'm8 20-4-4a2 2 0 0 1 0-3L13 4a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H8Zm-2-9 7 7m-2 2h10',
  info: 'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  exit: 'M10 5H5v14h5m-1-7h12m-4-4 4 4-4 4',
}

function ToolIcon({ name }: { name: keyof typeof toolPaths }) {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={toolPaths[name]} />
    </svg>
  )
}
