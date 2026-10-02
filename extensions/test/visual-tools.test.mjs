import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { EXTRA_PATH, findChrome } from "../visual-tools/tools/_common.mjs"
import { call, closeAll, connect, text } from "./helpers.mjs"

const noChrome = !findChrome() && "no Chrome/Chromium installed"
const PATH = [...EXTRA_PATH, process.env.PATH ?? ""].join(":")
const onPath = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { env: { ...process.env, PATH } }).status === 0

describe("visual-tools: tool groups", () => {
  test("mermaid group exposes only the mermaid trio", async () => {
    const { client, close } = await connect("visual-tools/index.mjs", { args: ["mermaid"] })
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["edit_mermaid", "render_mermaid", "write_mermaid"])
    await close()
  })
  test("svg group exposes only the svg trio", async () => {
    const { client, close } = await connect("visual-tools/index.mjs", { args: ["svg"] })
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["edit_svg", "render_svg", "write_svg"])
    await close()
  })
})

describe("visual-tools: mermaid loop", () => {
  let s
  before(async () => (s = await connect("visual-tools/index.mjs", { args: ["mermaid"] })))
  after(() => s.close())

  test("edit/render before write is an error", async () => {
    const r = await call(s.client, "render_mermaid", {})
    assert.equal(r.isError, true)
    assert.match(text(r), /call write_mermaid first/)
  })

  test("write → edit (exact match rules)", async () => {
    let r = await call(s.client, "write_mermaid", { source: "graph TD\n  A[packet] --> B[ordering]\n  A --> C[retransmit]" })
    assert.match(text(r), /Wrote 3-line Mermaid source/)
    r = await call(s.client, "edit_mermaid", { old_text: "nope", new_text: "x" })
    assert.equal(r.isError, true)
    r = await call(s.client, "edit_mermaid", { old_text: "A -->", new_text: "A ==>" })
    assert.equal(r.isError, undefined)
    assert.match(text(r), /A ==> C\[retransmit\]/)
  })

  test("render preview returns an inline PNG", { skip: noChrome, timeout: 120_000 }, async () => {
    const r = await call(s.client, "render_mermaid", {})
    const img = r.content.find((c) => c.type === "image")
    assert.ok(img, text(r))
    assert.equal(img.mimeType, "image/png")
    assert.ok(Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG")
    assert.ok(!existsSync(join(s.projectDir, "viz")), "preview must not publish")
  })

  test("render with save_as publishes into <project>/viz", { skip: noChrome, timeout: 120_000 }, async () => {
    const r = await call(s.client, "render_mermaid", { save_as: "TCP Reliability!" })
    const m = /filename: (viz-tcp-reliability-\d+\.png)\npath: (.+)/.exec(text(r))
    assert.ok(m, text(r))
    assert.equal(m[2], join(s.projectDir, "viz", m[1]))
    assert.ok(existsSync(m[2]))
  })

  test("a syntax error comes back as text, not an image", { skip: noChrome, timeout: 120_000 }, async () => {
    await call(s.client, "write_mermaid", { source: "graph TD\n  A -->" })
    const r = await call(s.client, "render_mermaid", {})
    assert.ok(!r.content.some((c) => c.type === "image"))
    assert.match(text(r), /Mermaid render FAILED/)
  })
})

describe("visual-tools: svg loop", () => {
  let s
  before(async () => (s = await connect("visual-tools/index.mjs", { args: ["svg"] })))
  after(() => s.close())

  test("write rejects non-svg source", async () => {
    const r = await call(s.client, "write_svg", { source: "<div>hi</div>" })
    assert.equal(r.isError, true)
  })

  test("write → render → publish", { timeout: 120_000 }, async () => {
    await call(s.client, "write_svg", {
      source:
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">' +
        '<rect width="200" height="80" fill="white"/><line x1="10" y1="40" x2="190" y2="40" stroke="black" stroke-width="2"/>' +
        '<text x="100" y="30" font-family="sans-serif" font-size="16" text-anchor="middle">0 to 1</text></svg>',
    })
    let r = await call(s.client, "render_svg", {})
    assert.ok(r.content.some((c) => c.type === "image"), text(r))
    r = await call(s.client, "render_svg", { save_as: "number-line" })
    const m = /path: (.+)/.exec(text(r))
    assert.ok(m && existsSync(m[1]), text(r))
  })

  const chromeRenders = !onPath("rsvg-convert") && !onPath("magick")
  test("the headless Chrome fallback runs no scripts and fetches nothing", { skip: (!chromeRenders && "rsvg-convert or ImageMagick renders SVG here") || noChrome, timeout: 120_000 }, async () => {
    let hits = 0
    const server = createServer((req, res) => (hits++, res.end()))
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    try {
      await call(s.client, "write_svg", {
        source:
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="white"/>' +
          `<image href="${url}/img.png" width="10" height="10"/><script>fetch("${url}/js")</script></svg>`,
      })
      const r = await call(s.client, "render_svg", {})
      assert.ok(r.content.some((c) => c.type === "image"), text(r))
      assert.equal(hits, 0)
    } finally {
      server.close()
    }
  })
})

after(closeAll)
