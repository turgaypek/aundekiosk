import { createStaticHandler } from "./static.ts";
import { assertEquals } from "./test_util.ts";

async function withTempPublicDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>home</h1>");
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/sub/style.css`, "body{}");
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("serves index.html for the root path", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/");
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<h1>home</h1>");
  });
});

Deno.test("serves nested files with the right content type", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/sub/style.css");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/css; charset=utf-8");
  });
});

Deno.test("returns 404 for a file that does not exist", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/missing.html");
    assertEquals(res.status, 404);
  });
});

Deno.test("blocks path traversal attempts outside the public dir", async () => {
  await withTempPublicDir(async (dir) => {
    const secretPath = `${dir}-secret.txt`;
    await Deno.writeTextFile(secretPath, "top secret");
    try {
      const handle = createStaticHandler(dir);
      const res = await handle("/../" + secretPath.split("/").pop());
      assertEquals(res.status, 404);
    } finally {
      await Deno.remove(secretPath);
    }
  });
});
