import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 3001);
const MAX_PARTICIPANTS = 4;
const MAX_MESSAGE_BYTES = 256 * 1024;
const rooms = new Map();

const server = new WebSocketServer({
  host: process.env.HOST ?? '0.0.0.0',
  port: PORT,
  maxPayload: MAX_MESSAGE_BYTES,
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket, code, message) {
  send(socket, { type: 'room.error', code, message });
}

function broadcast(room, message, exceptPeerId = null) {
  for (const [peerId, participant] of room.participants) {
    if (peerId !== exceptPeerId) send(participant.socket, message);
  }
}

function leaveRoom(socket) {
  const { roomCode, peerId } = socket;
  if (!roomCode || !peerId) return;

  const room = rooms.get(roomCode);
  socket.roomCode = null;
  socket.peerId = null;
  if (!room) return;

  room.participants.delete(peerId);
  broadcast(room, { type: 'peer.left', peerId });
  if (room.participants.size === 0) rooms.delete(roomCode);
}

function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const roomCode = value.trim().toUpperCase();
  return roomCode.length >= 1 && roomCode.length <= 32 ? roomCode : null;
}

function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  return length >= 1 && length <= 24 ? nickname : null;
}

function joinRoom(socket, message) {
  if (socket.peerId) {
    sendError(socket, 'INVALID_MESSAGE', 'Esta conexão já entrou em uma sala.');
    return;
  }

  const roomCode = normalizeRoomCode(message.roomCode);
  const nickname = normalizeNickname(message.nickname);
  if (!roomCode) {
    sendError(socket, 'INVALID_ROOM_CODE', 'O código deve ter entre 1 e 32 caracteres.');
    return;
  }
  if (!nickname) {
    sendError(socket, 'INVALID_NICKNAME', 'O apelido deve ter entre 1 e 24 caracteres.');
    return;
  }

  let room = rooms.get(roomCode);
  if (!room) {
    room = { participants: new Map() };
    rooms.set(roomCode, room);
  }
  if (room.participants.size >= MAX_PARTICIPANTS) {
    if (room.participants.size === 0) rooms.delete(roomCode);
    sendError(socket, 'ROOM_FULL', 'A sala já atingiu o limite de 4 participantes.');
    return;
  }

  const self = { peerId: randomUUID(), nickname };
  const peers = [...room.participants.values()].map(({ info }) => info);
  const snapshotProviderId = peers[0]?.peerId ?? null;
  socket.roomCode = roomCode;
  socket.peerId = self.peerId;
  room.participants.set(self.peerId, { info: self, socket });

  send(socket, { type: 'room.joined', roomCode, self, peers, snapshotProviderId });
  broadcast(room, { type: 'peer.joined', peer: self }, self.peerId);
}

function validDescription(value, expectedType) {
  return value !== null
    && typeof value === 'object'
    && value.type === expectedType
    && typeof value.sdp === 'string'
    && value.sdp.length <= 200_000;
}

function validIceCandidate(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.candidate === 'string'
    && value.candidate.length <= 8_192;
}

function relaySignal(socket, message) {
  if (!socket.roomCode || !socket.peerId) {
    sendError(socket, 'NOT_IN_ROOM', 'Entre em uma sala antes de negociar a conexão.');
    return;
  }

  const room = rooms.get(socket.roomCode);
  const target = room?.participants.get(message.toPeerId);
  if (!target || target.info.peerId === socket.peerId) {
    sendError(socket, 'PEER_NOT_FOUND', 'O participante de destino não está na sala.');
    return;
  }

  let forwarded;
  if (message.type === 'signal.offer' && validDescription(message.description, 'offer')) {
    forwarded = {
      type: 'signal.offer',
      fromPeerId: socket.peerId,
      description: message.description,
    };
  } else if (message.type === 'signal.answer' && validDescription(message.description, 'answer')) {
    forwarded = {
      type: 'signal.answer',
      fromPeerId: socket.peerId,
      description: message.description,
    };
  } else if (message.type === 'signal.ice' && validIceCandidate(message.candidate)) {
    forwarded = {
      type: 'signal.ice',
      fromPeerId: socket.peerId,
      candidate: message.candidate,
    };
  } else {
    sendError(socket, 'INVALID_MESSAGE', 'A mensagem de negociação está inválida.');
    return;
  }

  send(target.socket, forwarded);
}

server.on('connection', (socket) => {
  socket.roomCode = null;
  socket.peerId = null;

  socket.on('message', (raw, isBinary) => {
    if (isBinary || raw.byteLength > MAX_MESSAGE_BYTES) {
      sendError(socket, 'INVALID_MESSAGE', 'Envie uma mensagem JSON de até 256 KiB.');
      socket.close(1009, 'Message too large or binary');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendError(socket, 'INVALID_MESSAGE', 'A mensagem não contém JSON válido.');
      return;
    }

    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      sendError(socket, 'INVALID_MESSAGE', 'Formato de mensagem inválido.');
      return;
    }

    if (message.type === 'room.join') {
      joinRoom(socket, message);
    } else if (message.type === 'room.leave') {
      leaveRoom(socket);
    } else if (['signal.offer', 'signal.answer', 'signal.ice'].includes(message.type)) {
      relaySignal(socket, message);
    } else if (!socket.peerId) {
      sendError(socket, 'NOT_IN_ROOM', 'Entre em uma sala antes de enviar esta mensagem.');
    } else {
      sendError(socket, 'INVALID_MESSAGE', 'Tipo de mensagem desconhecido.');
    }
  });

  socket.on('close', () => leaveRoom(socket));
  socket.on('error', (error) => console.error('WebSocket error:', error.message));
});

server.on('listening', () => {
  console.log(`Signaling pronto em ws://${process.env.HOST ?? '0.0.0.0'}:${PORT}`);
});

server.on('error', (error) => {
  console.error('Falha no servidor de signaling:', error.message);
  process.exitCode = 1;
});
