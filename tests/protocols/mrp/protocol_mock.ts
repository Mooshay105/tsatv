/** Fixtures and code shared between MRP tests. */

import { MessageDispatcher } from "../../../src/core/protocol.ts";
import type * as pb from "../../../src/protocols/mrp/protobuf/index.ts";

// This mock is _extremely_ basic, so needs to be adjusted heavily when adding new tests
export class MrpProtocolMock extends MessageDispatcher<number, pb.ProtocolMessage> {
  sentMessages: pb.ProtocolMessage[] = [];
  deviceInfo: pb.ProtocolMessage | null = null;

  async send(message: pb.ProtocolMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  async inject(message: pb.ProtocolMessage): Promise<void> {
    await Promise.all(this.dispatch(message.type, message));
  }
}
