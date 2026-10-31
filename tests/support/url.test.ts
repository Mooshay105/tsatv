import { expect, test } from "bun:test";
import { isUrl, isUrlOrScheme } from "../../src/support/url.ts";

const APP_URL =
  "com.apple.tv://tv.apple.com/show/marvels-spidey-and-his-amazing-friends/umc.cmc.3ambs8tqwzphbn0u8e9g76x7m?profile=kids&action=play";

test("is url accepts http url", () => expect(isUrl("http://example.com")).toBe(true));
test("is url accepts app url", () => expect(isUrl(APP_URL)).toBe(true));
test("is url rejects bundle id", () => expect(isUrl("com.apple.tv")).toBe(false));
test("is url rejects scheme", () => expect(isUrl("com.apple.tv://")).toBe(false));
test("is url or scheme accepts http url", () => expect(isUrlOrScheme("http://example.com")).toBe(true));
test("is url or scheme accepts app url", () => expect(isUrlOrScheme(APP_URL)).toBe(true));
test("is url or scheme rejects bundle id", () => expect(isUrlOrScheme("com.apple.tv")).toBe(false));
test("is url or scheme accepts scheme", () => expect(isUrlOrScheme("com.apple.tv://")).toBe(true));
