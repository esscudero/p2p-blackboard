export type PeerInfo = {
  peerId: string;
  nickname: string;
};

export type RoomErrorCode =
  | 'INVALID_ROOM_CODE'
  | 'INVALID_NICKNAME'
  | 'ROOM_FULL'
  | 'NOT_IN_ROOM'
  | 'PEER_NOT_FOUND'
  | 'INVALID_MESSAGE';

export type ClientSignalMessage =
  | { type: 'room.join'; roomCode: string; nickname: string }
  | { type: 'room.leave' }
  | { type: 'signal.offer'; toPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.answer'; toPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.ice'; toPeerId: string; candidate: RTCIceCandidateInit };

export type ServerSignalMessage =
  | {
      type: 'room.joined';
      roomCode: string;
      self: PeerInfo;
      peers: PeerInfo[];
      snapshotProviderId: string | null;
    }
  | { type: 'peer.joined'; peer: PeerInfo }
  | { type: 'peer.left'; peerId: string }
  | { type: 'signal.offer'; fromPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.answer'; fromPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.ice'; fromPeerId: string; candidate: RTCIceCandidateInit }
  | { type: 'room.error'; code: RoomErrorCode; message: string };
