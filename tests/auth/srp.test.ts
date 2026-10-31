/** Tests for SRP implementation (not present in Python version, uses RFC 5054 vectors). */

import { expect, test } from "bun:test";
import { SRPClientSession, SRPContext, SRPServerSession } from "../../src/support/srp.ts";

// RFC 5054, Appendix B (1024 bit group, SHA-1)
const N1024 = BigInt(
  "0xEEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3",
);

test("rfc 5054 test vectors", () => {
  const ctx = new SRPContext("alice", "password123", N1024, 2n, "sha1");
  const salt = Buffer.from("BEB25379D1A8581EB5A727673A2441EE", "hex");
  const a = BigInt("0x60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393");
  const b = BigInt("0xE487CB59D31AC550471E81F00F6928E01DDA08E974A004F49E61F5D105284D20");

  expect(ctx.multiplier.toString(16).toUpperCase()).toBe("7556AA045AEF2CDD07ABAF0F665C3E818913186F");
  expect(ctx.passwordHash(salt).toString(16).toUpperCase()).toBe("94B7555AABE9127CC58CCF4993DB6CF84D16C124");

  const client = new SRPClientSession(ctx, a);
  const server = new SRPServerSession(ctx, salt, b);
  expect(client.publicValue.toString(16).toUpperCase()).toBe(
    "61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC44352E8903211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC8E39356179EAE45E42BA92AEACED825171E1E8B9AF6D9C03E1327F44BE087EF06530E69F66615261EEF54073CA11CF5858F0EDFDFE15EFEAB349EF5D76988A3672FAC47B0769447B",
  );
  expect(server.publicValue.toString(16).toUpperCase()).toBe(
    "BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011BAF38964DC46A0670DD125B95A981652236F99D9B681CBF87837EC996C6DA04453728610D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA37089E6F9C6059F388838E7A00030B331EB76840910440B1B27AAEAEEB4012B7D7665238A8E3FB004B117B58",
  );
  expect(ctx.commonSecret(client.publicValue, server.publicValue).toString(16).toUpperCase()).toBe(
    "CE38B9593487DA98554ED47D70A7AE5F462EF019",
  );

  client.process(server.public, salt);
  server.process(client.public);
  expect(client.key).toEqual(server.key);
  // K = H(PAD(S)) where S is the premaster secret from RFC 5054
  const premaster = Buffer.from(
    "B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D233861E359B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C41BB59B6D5979B5C00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F3499B200210DCC1F10EB33943CD67FC88A2F39A4BE5BEC4EC0A3212DC346D7E474B29EDE8A469FFECA686E5A",
    "hex",
  );
  expect(client.key).toEqual(ctx.hash(premaster));
  expect(server.verifyProof(client.keyProof)).toBe(true);
  expect(client.verifyProof(server.keyProofHash)).toBe(true);
});

test("client and server agree with 3072 bit group", () => {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const client = new SRPClientSession(new SRPContext("Pair-Setup", "1111"));
  const server = new SRPServerSession(new SRPContext("Pair-Setup", "1111"), salt);
  client.process(server.public, salt);
  server.process(client.public);
  expect(client.key).toEqual(server.key);
  expect(server.verifyProof(client.keyProof)).toBe(true);
});

test("wrong password fails proof", () => {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const client = new SRPClientSession(new SRPContext("Pair-Setup", "1234"));
  const server = new SRPServerSession(new SRPContext("Pair-Setup", "1111"), salt);
  client.process(server.public, salt);
  server.process(client.public);
  expect(server.verifyProof(client.keyProof)).toBe(false);
});
