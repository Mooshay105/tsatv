/** Unit tests for pyatv.core.relayer. */

import { expect, test } from "bun:test";
import { Protocol } from "../../src/const.ts";
import { Relayer } from "../../src/core/relayer.ts";
import { InvalidStateError, NotSupportedError } from "../../src/exceptions.ts";

class BaseClass {
  noArgs(): any {}
  withArgs(_arg: number): any {}
  withKwargs(_kwargs: { a: number; b: number }): any {}
  get prop(): any {
    return undefined;
  }
  async asyncNoArgs(): Promise<any> {}
  async asyncWithArgs(_arg: number): Promise<any> {}
  async asyncWithKwargs(_kwargs: { a: number; b: number }): Promise<any> {}
}

class SubClass1 extends BaseClass {
  override noArgs() {
    return "subclass1";
  }
  override withArgs(arg: number) {
    return arg * 2;
  }
  override withKwargs(kwargs: { a: number; b: number }) {
    return kwargs.a * kwargs.b;
  }
  override get prop() {
    return 123;
  }
  override async asyncNoArgs() {
    return "subclass1";
  }
  override async asyncWithArgs(arg: number) {
    return arg * 2;
  }
  override async asyncWithKwargs(kwargs: { a: number; b: number }) {
    return kwargs.a * kwargs.b;
  }
}

class SubClass2 extends BaseClass {
  override withArgs(arg: number) {
    return arg;
  }
}

class SubClass3 extends BaseClass {
  override withKwargs(kwargs: { a: number; b: number }) {
    return kwargs.a - kwargs.b;
  }
}

class SubClass4 extends BaseClass {
  constructor(readonly retString: string) {
    super();
  }
  override noArgs() {
    return this.retString;
  }
}

const relayBaseOnly = () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  relayer.register(new SubClass1(), Protocol.MRP);
  return relayer;
};

test("base cases", async () => {
  const relayer = relayBaseOnly();
  expect(relayer.relay("noArgs")()).toBe("subclass1");
  expect(relayer.relay("withArgs")(3)).toBe(6);
  expect(relayer.relay("withKwargs")({ a: 2, b: 3 })).toBe(6);
  expect(relayer.relay("prop")).toBe(123);
  expect(await relayer.relay("asyncNoArgs")()).toBe("subclass1");
  expect(await relayer.relay("asyncWithArgs")(3)).toBe(6);
  expect(await relayer.relay("asyncWithKwargs")({ a: 2, b: 3 })).toBe(6);
});

test("class priority", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(new SubClass1(), Protocol.AirPlay);
  relayer.register(new SubClass3(), Protocol.MRP);
  relayer.register(new SubClass2(), Protocol.DMAP);
  expect(relayer.relay("noArgs")()).toBe("subclass1");
  expect(relayer.relay("withArgs")(3)).toBe(3);
  expect(relayer.relay("withKwargs")({ a: 4, b: 1 })).toBe(3);
});

test("relay missing instance ignored and raises not found", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  expect(() => relayer.relay("noArgs")).toThrow(NotSupportedError);
});

test("relay missing target raises", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  relayer.register(new SubClass2(), Protocol.MRP);
  expect(() => relayer.relay("noArgs")).toThrow(NotSupportedError);
});

test("relay method not in interface raises", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  relayer.register(new SubClass2(), Protocol.MRP);
  expect(() => relayer.relay("missingMethod")).toThrow(Error);
});

test("add instance not in priority list raises", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  expect(() => relayer.register(new SubClass1(), Protocol.DMAP)).toThrow(Error);
});

test("relay override priority", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP]);
  relayer.register(new SubClass1(), Protocol.DMAP);
  relayer.register(new SubClass2(), Protocol.MRP);
  expect(relayer.relay("withArgs", [Protocol.MRP, Protocol.DMAP])(3)).toBe(3);
  expect(relayer.relay("withArgs", [Protocol.DMAP, Protocol.MRP])(3)).toBe(6);
});

test("main instance", () => {
  const instance2 = new SubClass2();
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(new SubClass1(), Protocol.DMAP);
  relayer.register(new SubClass3(), Protocol.AirPlay);
  relayer.register(instance2, Protocol.MRP);
  expect(relayer.mainInstance).toBe(instance2);
});

test("main instance missing instance for priority", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP]);
  expect(() => relayer.mainInstance).toThrow(NotSupportedError);
});

test("main protocol", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(new SubClass1(), Protocol.AirPlay);
  expect(relayer.mainProtocol).toBe(Protocol.AirPlay);
  relayer.register(new SubClass1(), Protocol.DMAP);
  expect(relayer.mainProtocol).toBe(Protocol.DMAP);
  relayer.register(new SubClass1(), Protocol.MRP);
  expect(relayer.mainProtocol).toBe(Protocol.MRP);
});

test("main protocol with no instance", () => {
  expect(new Relayer(BaseClass, [Protocol.MRP]).mainProtocol).toBeNull();
});

test("takeover overrides main protocol", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP]);
  relayer.register(new SubClass4("mrp"), Protocol.MRP);
  relayer.register(new SubClass4("dmap"), Protocol.DMAP);
  relayer.takeover(Protocol.DMAP);
  expect(relayer.mainProtocol).toBe(Protocol.DMAP);
});

test("get instance of type", () => {
  const instance1 = new SubClass1();
  const instance2 = new SubClass2();
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(instance1, Protocol.MRP);
  relayer.register(instance2, Protocol.DMAP);
  expect(relayer.get(Protocol.MRP)).toBe(instance1);
  expect(relayer.get(Protocol.DMAP)).toBe(instance2);
  expect(relayer.get(Protocol.AirPlay)).toBeNull();
});

test("takeover and release", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(new SubClass4("airplay"), Protocol.AirPlay);
  relayer.register(new SubClass4("mrp"), Protocol.MRP);
  relayer.register(new SubClass4("dmap"), Protocol.DMAP);
  expect(relayer.relay("noArgs")()).toBe("mrp");
  relayer.takeover(Protocol.AirPlay);
  expect(relayer.relay("noArgs")()).toBe("airplay");
  relayer.release();
  expect(relayer.relay("noArgs")()).toBe("mrp");
});

test("takeover while takeover raises", () => {
  const relayer = new Relayer(BaseClass, [Protocol.AirPlay]);
  relayer.register(new SubClass4("airplay"), Protocol.AirPlay);
  relayer.takeover(Protocol.DMAP);
  expect(() => relayer.takeover(Protocol.DMAP)).toThrow(InvalidStateError);
});

test("takeover overrides manual priority", () => {
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(new SubClass4("airplay"), Protocol.AirPlay);
  relayer.register(new SubClass4("mrp"), Protocol.MRP);
  relayer.register(new SubClass4("dmap"), Protocol.DMAP);
  relayer.takeover(Protocol.AirPlay);
  expect(relayer.relay("noArgs", [Protocol.DMAP, Protocol.MRP, Protocol.AirPlay])()).toBe("airplay");
});

test("takeover with missing implementation", () => {
  const relayer = new Relayer(BaseClass, [Protocol.AirPlay, Protocol.DMAP]);
  relayer.register(new SubClass1(), Protocol.AirPlay);
  relayer.register(new BaseClass(), Protocol.DMAP);
  relayer.takeover(Protocol.DMAP);
  expect(relayer.relay("noArgs")()).toBe("subclass1");
});

test("takeover overrides main instance", () => {
  const relayer = new Relayer<SubClass4>(BaseClass, [Protocol.MRP, Protocol.DMAP]);
  relayer.register(new SubClass4("mrp"), Protocol.MRP);
  relayer.register(new SubClass4("dmap"), Protocol.DMAP);
  relayer.takeover(Protocol.DMAP);
  expect(relayer.mainInstance.noArgs()).toBe("dmap");
});

test("get all instances", () => {
  const mrp = new SubClass4("mrp");
  const dmap = new SubClass4("dmap");
  const airplay = new SubClass4("airplay");
  const relayer = new Relayer(BaseClass, [Protocol.MRP, Protocol.DMAP, Protocol.AirPlay]);
  relayer.register(mrp, Protocol.MRP);
  relayer.register(dmap, Protocol.DMAP);
  relayer.register(airplay, Protocol.AirPlay);
  const instances = relayer.instances;
  expect(instances.length).toBe(3);
  expect(instances).toContain(mrp);
  expect(instances).toContain(dmap);
  expect(instances).toContain(airplay);
});
