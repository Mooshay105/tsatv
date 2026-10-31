/** Packet formats used by RAOP. */

import { defpacket } from "../../support/packet.ts";

export const RtpHeader = defpacket<{ proto: number; type: number; seqno: number }>("RtpHeader", {
  proto: "B",
  type: "B",
  seqno: "H",
});

export const TimingPacket = RtpHeader.extend<{
  padding: number;
  reftimeSec: number;
  reftimeFrac: number;
  recvtimeSec: number;
  recvtimeFrac: number;
  sendtimeSec: number;
  sendtimeFrac: number;
}>("TimingPacket", {
  padding: "I",
  reftimeSec: "I",
  reftimeFrac: "I",
  recvtimeSec: "I",
  recvtimeFrac: "I",
  sendtimeSec: "I",
  sendtimeFrac: "I",
});

export const SyncPacket = RtpHeader.extend<{ nowWithoutLatency: number; lastSyncSec: number; lastSyncFrac: number; now: number }>(
  "SyncPacket",
  { nowWithoutLatency: "I", lastSyncSec: "I", lastSyncFrac: "I", now: "I" },
);

// NB: Audio payload is not included here, shall be appended manually
export const AudioPacketHeader = RtpHeader.extend<{ timestamp: number; ssrc: number }>("AudioPacketHeader", {
  timestamp: "I",
  ssrc: "I",
});

export const RetransmitReqeust = RtpHeader.extend<{ lostSeqno: number; lostPackets: number }>("RetransmitPacket", {
  lostSeqno: "H",
  lostPackets: "H",
});
