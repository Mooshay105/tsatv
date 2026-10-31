/** Unit tests for pyatv.support. */

import { describe, expect, mock, test } from "bun:test";
import { BackOffError, ConnectionFailedError, NoCredentialsError, OSError } from "../../src/exceptions.ts";
import { TimeoutError } from "../../src/support/asyncio.ts";
import {
  AssertionError,
  AttributeError,
  errorHandler,
  logBinary,
  mapRange,
  prettyRepr,
  shiftHexIdentifier,
  stringifyModel,
  updateModelField,
} from "../../src/support/index.ts";
import { LogLevel, pyFormat } from "../../src/support/logging.ts";
import { type FieldSpec, Model, ValidationError } from "../../src/support/model.ts";
import { b } from "../utils.ts";

class DummyException extends Error {}

function makeLogger(enabled = true) {
  return { isEnabledFor: mock((_level: LogLevel) => enabled), debug: mock((..._args: unknown[]) => undefined) };
}

async function doraise(exception: new () => Error): Promise<never> {
  throw new exception();
}

// This method generates the formatted debug string
function debugString(logger: ReturnType<typeof makeLogger>): string {
  const [formatting, ...args] = logger.debug.mock.calls[logger.debug.mock.calls.length - 1]!;
  return pyFormat(formatting as string, args);
}

test("error handler return value", async () => {
  expect(await errorHandler(async () => 123, DummyException)).toBe(123);
});

test("error handler oserror", async () => {
  await expect(errorHandler(doraise, DummyException, OSError)).rejects.toBeInstanceOf(ConnectionFailedError);
});

test("error handler timeout", async () => {
  await expect(errorHandler(doraise, DummyException, TimeoutError)).rejects.toBeInstanceOf(ConnectionFailedError);
});

test("error handler backoff", async () => {
  await expect(errorHandler(doraise, DummyException, BackOffError)).rejects.toBeInstanceOf(BackOffError);
});

test("error handler no credentials", async () => {
  await expect(errorHandler(doraise, DummyException, NoCredentialsError)).rejects.toBeInstanceOf(NoCredentialsError);
});

test("error handler other exception", async () => {
  await expect(errorHandler(doraise, DummyException, Error)).rejects.toBeInstanceOf(DummyException);
});

test("log binary no log if not debug", () => {
  const logger = makeLogger(false);
  logBinary(logger, "test");
  expect(logger.isEnabledFor).toHaveBeenCalledWith(LogLevel.DEBUG);
});

test("log binary no log if not custom level", () => {
  const logger = makeLogger(false);
  logBinary(logger, "test", {}, LogLevel.INFO);
  expect(logger.isEnabledFor).toHaveBeenCalledWith(LogLevel.INFO);
});

test("log binary log no args if enabled", () => {
  const logger = makeLogger();
  logBinary(logger, "testing");
  expect(debugString(logger)).toBe("testing ()");
});

test("log binary log empty value if enabled", () => {
  const logger = makeLogger();
  logBinary(logger, "testing", { test: null });
  expect(debugString(logger)).toBe("testing (test=)");
});

test("log binary log single arg if enabled", () => {
  const logger = makeLogger();
  logBinary(logger, "abc", { test: b("\x01\x02") });
  expect(debugString(logger)).toBe("abc (test=0102)");
});

test("log binary log multiple args if enabled", () => {
  const logger = makeLogger();
  logBinary(logger, "k", { test: b("\x01\x02"), dummy: b("\xfe") });
  expect(debugString(logger)).toBe("k (dummy=fe, test=0102)");
});

test("log binary log limit output", () => {
  const logger = makeLogger();
  logBinary(logger, "msg", { a: b("\x01".repeat(1024)), b: b("\x02".repeat(1024)) });
  // Output will become "msg (a=, b=)" (length 12) plus 2 * 512 for limit = 1036
  expect(debugString(logger).length).toBe(1036);
});

test("log binary non bytes as string", () => {
  const logger = makeLogger();
  logBinary(logger, "msg", { a: b("\x01"), b: 123, c: "test" });
  expect(debugString(logger)).toBe("msg (a=01, b=123, c=test)");
});

test("map range", () => {
  expect(mapRange(1.0, 0.0, 25.0, 0.0, 100.0)).toBeCloseTo(4.0);
});

test.each([
  [0.0, 0.0, 0.0, 1.0],
  [1.0, 0.0, 0.0, 1.0],
  [0.0, 1.0, 0.0, 0.0],
  [0.0, 1.0, 1.0, 0.0],
])("map range bad ranges %p %p %p %p", (inMin, inMax, outMin, outMax) => {
  expect(() => mapRange(1, inMin, inMax, outMin, outMax)).toThrow(RangeError);
});

test.each([-1.0, 11.0])("map range bad input values %p", (value) => {
  expect(() => mapRange(value, 0.0, 10.0, 20.0, 30.0)).toThrow(RangeError);
});

test.each([
  ["00:11:22:33:44:55", "01:11:22:33:44:55"],
  ["01:11:22:33:44:55", "02:11:22:33:44:55"],
  ["FF:11:22:33:44:55", "00:11:22:33:44:55"],
  ["00000000-1111-2222-3333-444444444444", "01000000-1111-2222-3333-444444444444"],
  ["01000000-1111-2222-3333-444444444444", "02000000-1111-2222-3333-444444444444"],
  ["FF000000-1111-2222-3333-444444444444", "00000000-1111-2222-3333-444444444444"],
  [
    "00000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
    "01000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
  ],
  [
    "01000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
    "02000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
  ],
  [
    "FF000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
    "00000000-1111-2222-3333-444444444444+55555555-6666-7777-8888-999999999999",
  ],
])("shift hex identifier %s", (input, output) => {
  expect(shiftHexIdentifier(input)).toBe(output);
});

test.each(["", "a"])("shift hex identifier min length %p", (input) => {
  expect(() => shiftHexIdentifier(input)).toThrow(AssertionError);
});

test.each([
  [3, 10, "..."],
  [4, 10, "a..."],
  [10, 5, "aaaaa"],
])("pretty repr %p %p", (maxLength, dataCount, expected) => {
  expect(prettyRepr("Dummy", { data: "a".repeat(dataCount), raw: b("a".repeat(dataCount)) }, maxLength)).toBe(
    `Dummy(data=${expected}, raw=b'${expected}')`,
  );
});

// Related to models (pydantic in Python)

class SubModel extends Model {
  declare a: number;
  declare b: string;
  static SCHEMA: Record<string, FieldSpec> = {
    a: { type: { kind: "int" }, default: () => 1 },
    b: { type: { kind: "str" }, default: () => "test" },
  };
  constructor() {
    super();
    this.init();
  }
  get schema() {
    return SubModel.SCHEMA;
  }
}

class TopModel extends Model {
  declare test: number;
  declare sub_model: SubModel;
  declare foobar: string;
  static SCHEMA: Record<string, FieldSpec> = {
    test: { type: { kind: "int" }, default: () => 1234 },
    sub_model: { type: { kind: "model", factory: () => new SubModel() }, default: () => new SubModel() },
    foobar: { type: { kind: "str" }, default: () => "hej" },
  };
  constructor() {
    super();
    this.init();
  }
  get schema() {
    return TopModel.SCHEMA;
  }
}

class ModelWithOptionalField extends Model {
  declare a: string | null;
  static SCHEMA: Record<string, FieldSpec> = {
    a: { type: { kind: "str", optional: true }, default: () => "test" },
  };
  constructor() {
    super();
    this.init();
  }
  get schema() {
    return ModelWithOptionalField.SCHEMA;
  }
}

describe("models", () => {
  test("dump simple model", () => {
    expect(stringifyModel(new SubModel())).toEqual(["a = 1 (int)", "b = test (str)"]);
  });

  test("dump with submodel", () => {
    expect(stringifyModel(new TopModel())).toEqual([
      "test = 1234 (int)",
      "sub_model.a = 1 (int)",
      "sub_model.b = test (str)",
      "foobar = hej (str)",
    ]);
  });

  test("dump with optional field", () => {
    expect(stringifyModel(new ModelWithOptionalField())).toEqual(["a = test (str, NoneType)"]);
  });

  test("dump with changed values", () => {
    const model = new TopModel();
    model.test = 555;
    model.sub_model.a = 2;
    expect(stringifyModel(model)).toEqual([
      "test = 555 (int)",
      "sub_model.a = 2 (int)",
      "sub_model.b = test (str)",
      "foobar = hej (str)",
    ]);
  });

  test.each([
    ["a", 10],
    ["b", "test"],
  ] as Array<[string, string | number]>)("update field in simple model %s", (field, value) => {
    const model = new SubModel();
    updateModelField(model, field, value);
    expect((model as any)[field]).toBe(value);
  });

  test("update missing field raises", () => {
    expect(() => updateModelField(new SubModel(), "missing", 1)).toThrow(AttributeError);
  });

  test("update field in submodel", () => {
    const model = new TopModel();
    updateModelField(model, "sub_model.a", 1234);
    expect(model.sub_model.a).toBe(1234);
  });

  test("validate input before assigning", () => {
    const model = new SubModel();
    expect(() => updateModelField(model, "a", "test")).toThrow(ValidationError);
    expect(model.a).toBe(1);
  });
});

// Protobuf logging

import { logProtobuf } from "../../src/support/index.ts";
import { ProtocolMessage } from "../../src/protocols/mrp/protobuf/index.ts";
import { messageToString } from "../../src/protocols/mrp/protobuf/runtime.ts";
import { setProtobufFormatter } from "../../src/support/index.ts";

describe("log protobuf", () => {
  setProtobufFormatter((msg) => messageToString(msg as ProtocolMessage));
  const message = () => new ProtocolMessage({ identifier: "aaaaaaaaaa" });

  test("no log if not debug", () => {
    const logger = makeLogger(false);
    logProtobuf(logger, "test", message());
    expect(logger.isEnabledFor).toHaveBeenCalledWith(LogLevel.DEBUG);
  });

  test("log message", () => {
    const logger = makeLogger();
    logProtobuf(logger, "test", message());
    expect(debugString(logger)).toBe('test: identifier: "aaaaaaaaaa"');
  });

  test("log limit message max length", () => {
    const logger = makeLogger();
    const msg = message();
    msg.identifier = "a".repeat(200);
    logProtobuf(logger, "test", msg);
    expect(debugString(logger).length).toBe(156);
  });

  test("log with length override", () => {
    const logger = makeLogger();
    process.env.PYATV_PROTOBUF_MAX_LINE = "5";
    try {
      logProtobuf(logger, "text", message());
    } finally {
      delete process.env.PYATV_PROTOBUF_MAX_LINE;
    }
    expect(debugString(logger)).toBe("text: id...");
  });
});
