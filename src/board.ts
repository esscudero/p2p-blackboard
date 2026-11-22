export type Point = { x: number; y: number }
export type Version = { counter: number; peerId: string }
export const colors = ['yellow', 'blue', 'pink', 'green'] as const
export type NoteColor = typeof colors[number]
export type StickyNote = Point & { id: string; text: string; color: NoteColor; version: Version; creatorName?: string }
export type Stroke = {
  id: string; createdBy: string; creatorName?: string; color: string; width: number;
  points: Point[]; lastSeq: number; finished: boolean
}
export type BoardState = {
  strokes: Record<string, Stroke>; stickies: Record<string, StickyNote>; deleted: Record<string, Version>
}
type Payloads = {
  'stroke.start': { strokeId: string; color: string; width: number; firstPoint: Point; creatorName?: string }
  'stroke.points': { strokeId: string; fromSeq: number; points: Point[] }
  'stroke.end': { strokeId: string; finalSeq: number }
  'sticky.upsert': { sticky: StickyNote }
  'object.delete': { objectId: string; version: Version }
  'board.snapshot.request': { requestId: string }
  'board.snapshot': { requestId: string; state: BoardState }
}
type MessageType = keyof Payloads
type Message<K extends MessageType> = { protocol: 1; messageId: string; senderId: string; type: K; payload: Payloads[K] }
export type PeerMessage = { [K in MessageType]: Message<K> }[MessageType]
export const emptyBoard = (): BoardState => ({ strokes: {}, stickies: {}, deleted: {} })
const encoder = new TextEncoder()
const maxBytes = 256 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !Object.hasOwn(Object.prototype, value)
const numeric = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const integer = (value: unknown, min: number, max: number): value is number =>
  numeric(value, min, max) && Number.isSafeInteger(value)
const point = (value: unknown): value is Point =>
  isRecord(value) && numeric(value.x, 0, 1) && numeric(value.y, 0, 1)
const ink = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const version = (value: unknown): value is Version =>
  isRecord(value) && integer(value.counter, 1, Number.MAX_SAFE_INTEGER - 1) && id(value.peerId)
const author = (value: unknown) => value === undefined ||
  (typeof value === 'string' && value.trim().length > 0 && value.length <= 24)
const note = (value: unknown): value is StickyNote =>
  isRecord(value) && id(value.id) && author(value.creatorName) && version(value.version) &&
  typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 500 &&
  colors.some(color => color === value.color) && point(value)
const stroke = (value: unknown): value is Stroke =>
  isRecord(value) && id(value.id) && id(value.createdBy) && author(value.creatorName) && ink(value.color) &&
  numeric(value.width, 1, 24) && Array.isArray(value.points) && value.points.length >= 1 &&
  value.points.length <= 1000 && value.points.every(point) &&
  value.lastSeq === value.points.length - 1 && typeof value.finished === 'boolean'

function withinLimits(state: BoardState) {
  const strokes = Object.values(state.strokes)
  return strokes.length <= 100 && Object.keys(state.stickies).length <= 100 &&
    strokes.reduce((total, item) => total + item.points.length, 0) <= 5000
}

function snapshot(value: unknown): value is BoardState {
  if (!isRecord(value) || !isRecord(value.strokes) || !isRecord(value.stickies) || !isRecord(value.deleted)) return false
  if (!Object.entries(value.strokes).every(([key, item]) => stroke(item) && item.id === key) ||
      !Object.entries(value.stickies).every(([key, item]) => note(item) && item.id === key) ||
      !Object.entries(value.deleted).every(([key, item]) => id(key) && version(item))) return false
  return withinLimits(value as BoardState)
}

export function isPeerMessage(value: unknown): value is PeerMessage {
  if (!isRecord(value) || value.protocol !== 1 || !id(value.senderId) ||
      !id(value.messageId) || !isRecord(value.payload)) return false
  const p = value.payload
  switch (value.type) {
    case 'stroke.start': return id(p.strokeId) && author(p.creatorName) && ink(p.color) && numeric(p.width, 1, 24) && point(p.firstPoint)
    case 'stroke.points': return id(p.strokeId) && integer(p.fromSeq, 1, 999) && Array.isArray(p.points) &&
      p.points.length >= 1 && p.points.length <= 128 && p.fromSeq + p.points.length <= 1000 && p.points.every(point)
    case 'stroke.end': return id(p.strokeId) && integer(p.finalSeq, 0, 999)
    case 'sticky.upsert': return note(p.sticky) && p.sticky.version.peerId === value.senderId
    case 'object.delete': return id(p.objectId) && version(p.version) && p.version.peerId === value.senderId
    case 'board.snapshot.request': return id(p.requestId)
    case 'board.snapshot': return id(p.requestId) && snapshot(p.state)
    default: return false
  }
}

const newer = (a: Version, b?: Version) =>
  !b || a.counter > b.counter || (a.counter === b.counter && a.peerId > b.peerId)

function putNote(state: BoardState, item: StickyNote) {
  if (state.strokes[item.id] || !newer(item.version, state.deleted[item.id]) ||
      !newer(item.version, state.stickies[item.id]?.version)) return false
  state.stickies[item.id] = { ...item, creatorName: state.stickies[item.id]?.creatorName ?? item.creatorName }
  return true
}

function remove(state: BoardState, objectId: string, revision: Version) {
  if (!newer(revision, state.deleted[objectId])) return false
  state.deleted[objectId] = revision
  delete state.strokes[objectId]
  if (newer(revision, state.stickies[objectId]?.version)) delete state.stickies[objectId]
  return true
}

function merge(state: BoardState, incoming: BoardState) {
  for (const [key, revision] of Object.entries(incoming.deleted)) remove(state, key, revision)
  for (const item of Object.values(incoming.stickies)) putNote(state, item)
  for (const item of Object.values(incoming.strokes)) {
    if (state.deleted[item.id] || state.stickies[item.id]) continue
    const current = state.strokes[item.id]
    if (!current) {
      state.strokes[item.id] = item
    } else if (current.createdBy === item.createdBy) {
      const longest = item.lastSeq > current.lastSeq ? item : current
      state.strokes[item.id] = { ...longest, finished: current.finished || item.finished }
    }
  }
}

function apply(state: BoardState, message: PeerMessage) {
  const next: BoardState = { strokes: { ...state.strokes }, stickies: { ...state.stickies }, deleted: { ...state.deleted } }
  switch (message.type) {
    case 'stroke.start': {
      const { strokeId, color, width, firstPoint, creatorName } = message.payload
      if (next.deleted[strokeId] || next.strokes[strokeId] || next.stickies[strokeId]) return state
      next.strokes[strokeId] = { id: strokeId, createdBy: message.senderId, creatorName, color, width, points: [firstPoint], lastSeq: 0, finished: false }
      break
    }
    case 'stroke.points': {
      const { strokeId, fromSeq, points } = message.payload
      const current = next.strokes[strokeId]
      if (!current || current.createdBy !== message.senderId || current.finished || fromSeq > current.lastSeq + 1) return state
      const fresh = points.slice(current.lastSeq + 1 - fromSeq)
      if (!fresh.length) return state
      next.strokes[strokeId] = { ...current, points: [...current.points, ...fresh], lastSeq: current.lastSeq + fresh.length }
      break
    }
    case 'stroke.end': {
      const { strokeId, finalSeq } = message.payload
      const current = next.strokes[strokeId]
      if (!current || current.createdBy !== message.senderId || current.finished || current.lastSeq !== finalSeq) return state
      next.strokes[strokeId] = { ...current, finished: true }
      break
    }
    case 'sticky.upsert': if (!putNote(next, message.payload.sticky)) return state; break
    case 'object.delete': if (!remove(next, message.payload.objectId, message.payload.version)) return state; break
    case 'board.snapshot': merge(next, message.payload.state); break
    case 'board.snapshot.request': return state
  }
  return next
}

// Paths may be loaded over HTTP on the local network.
function messageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export class BoardSession {
  state = emptyBoard()
  private counter = 0
  private objectCounter = 0
  private pending: PeerMessage[] = []

  constructor(
    private readonly peerId: string,
    private readonly nickname: string,
    private readonly send: (message: PeerMessage, target?: string) => void,
    private readonly render: (state: BoardState) => void,
  ) {}

  private make<K extends MessageType>(type: K, payload: Payloads[K]): Message<K> {
    return { protocol: 1, messageId: messageId(), senderId: this.peerId, type, payload }
  }

  private update(message: PeerMessage) {
    const next = apply(this.state, message)
    if (next === this.state) return false
    if (!withinLimits(next) ||
        encoder.encode(JSON.stringify(this.make('board.snapshot', { requestId: '0'.repeat(128), state: next }))).length > maxBytes) {
      throw new Error('O quadro atingiu o limite de itens, pontos ou tamanho.')
    }
    this.state = next
    this.render(next)
    return true
  }

  private local(message: PeerMessage) {
    if (this.update(message)) this.send(message)
  }

  start(firstPoint: Point, color: string, width: number) {
    const strokeId = this.nextId()
    this.local(this.make('stroke.start', { strokeId, firstPoint, color, width, creatorName: this.nickname }))
    return strokeId
  }

  points(strokeId: string, points: Point[]) {
    const current = this.state.strokes[strokeId]
    if (!current) return
    if (current.points.length + points.length > 1000) throw new Error('Cada traço comporta até 1.000 pontos.')
    this.local(this.make('stroke.points', { strokeId, fromSeq: current.lastSeq + 1, points }))
  }

  end(strokeId: string) {
    const current = this.state.strokes[strokeId]
    if (current) this.local(this.make('stroke.end', { strokeId, finalSeq: current.lastSeq }))
  }

  save(item: Omit<StickyNote, 'id' | 'version' | 'creatorName'>, itemId?: string) {
    if (itemId && !this.state.stickies[itemId]) throw new Error('Este post-it foi removido.')
    const text = item.text.trim()
    if (!text || text.length > 500) throw new Error('Escreva de 1 a 500 caracteres.')
    const creatorName = itemId ? this.state.stickies[itemId]?.creatorName : this.nickname
    const sticky = { ...item, text, id: itemId ?? this.nextId(), version: this.nextVersion(), creatorName }
    this.local(this.make('sticky.upsert', { sticky }))
  }

  delete(objectId: string) {
    this.local(this.make('object.delete', { objectId, version: this.nextVersion() }))
  }

  requestSnapshot(target: string, requestId: string) {
    this.send(this.make('board.snapshot.request', { requestId }), target)
  }

  receive(message: PeerMessage) {
    if (message.type === 'board.snapshot.request') {
      this.send(this.make('board.snapshot', { requestId: message.payload.requestId, state: this.state }), message.senderId)
      return false
    }
    if (message.type === 'sticky.upsert') this.observe(message.payload.sticky.version)
    if (message.type === 'object.delete') this.observe(message.payload.version)
    if (message.type === 'stroke.points' || message.type === 'stroke.end') {
      const { strokeId } = message.payload
      const current = this.state.strokes[strokeId]
      if (this.state.deleted[strokeId]) return false
      const gap = message.type === 'stroke.points'
        ? message.payload.fromSeq > (current?.lastSeq ?? -1) + 1
        : message.payload.finalSeq > (current?.lastSeq ?? -1)
      if ((!current || gap) && (!current || current.createdBy === message.senderId)) {
        if (this.pending.length < 1000) this.pending.push(message)
        return false
      }
    }
    if (message.type === 'board.snapshot') {
      for (const item of Object.values(message.payload.state.stickies)) this.observe(item.version)
      for (const revision of Object.values(message.payload.state.deleted)) this.observe(revision)
    }
    const applied = this.update(message)
    if (message.type === 'board.snapshot' || message.type === 'stroke.start') {
      const buffered = this.pending
      this.pending = []
      for (const item of buffered) this.receive(item)
    }
    return applied
  }

  private observe(revision: Version) {
    this.counter = Math.max(this.counter, revision.counter)
  }

  private nextId() {
    return this.peerId + ':' + ++this.objectCounter
  }

  private nextVersion() {
    if (this.counter >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Limite de versões da sala atingido.')
    return { counter: ++this.counter, peerId: this.peerId }
  }
}
